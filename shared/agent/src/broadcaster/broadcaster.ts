// Provide the Broadcaster class, which encapsulates communications with a swappable broadcaster service
// (eg. Pubnub, SocketCluster) to receive messages in real-time
"use strict";
import HttpsProxyAgent from "https-proxy-agent";
import { Disposable, Emitter, Event } from "vscode-languageserver";
import { ApiProvider } from "../api/apiProvider";
import { PubnubConnection } from "./pubnubConnection";
import { SocketClusterConnection } from "./socketClusterConnection";

export interface BroadcasterConnectionOptions {
	withPresence?: boolean;
}

export interface BroadcasterConnection {
	disconnect():  void;
	subscribe(channels: string[], options?: BroadcasterConnectionOptions): void;
	unsubscribe(channels: string[]): void;
	reconnect(): void;
	confirmSubscriptions(channels: string[]): Promise<string[]>;
	fetchHistory(options: BroadcasterHistoryInput): Promise<BroadcasterHistoryOutput>;
}

export interface BroadcasterHistoryInput {
	channels: string[];
	since: number;
	debug?(msg: string, info?: any): void; // for debug messages
}

export interface BroadcasterMessage {
	message: any;
	timestamp: number;
}

export interface BroadcasterHistoryOutput {
	timestamp?: number;
	messages?: BroadcasterMessage[];
	reset?: boolean;
}

export type MessageCallback = (message: any) => void;
export type StatusCallback = (status: BroadcasterStatus) => void;

// use this interface to initialize the Broadcaster class
export interface BroadcasterInitializer {
	pubnubSubscribeKey?: string; // identifies our Pubnub account, comes from pubnubKey returned with the login response from the API
	accessToken: string; // access token for api requests
	authKey: string; // unique broadcaster token provided in the login response
	userId: string; // ID of the current user
	lastMessageReceivedAt?: number; // should persist across sessions, interruptions in service will retrieve messages since this time
	testMode?: boolean; // whether we emit test-mode statuses, not normally used in production
	debug?(msg: string, info?: any): void; // for debug messages
	proxyAgent?: HttpsProxyAgent;
	socketCluster?: {
		host: string,
		port: string
	};
}

// when providing channels to subscribe to, you can provide just the channel name,
// or if you want presence notifications, you can use this interface, specifying
// withPresence as true
export interface ChannelDescriptor {
	name: string;
	withPresence?: boolean;
}

// the BroadcasterConnection instance will emit a status through onStatusChange(), for some
// statuses, information on which channels are affected is also provided
export interface BroadcasterStatus {
	status: BroadcasterStatusType;
	channels?: string[];
	reconnected?: boolean;
}

export interface MessageEvent {
	receivedAt: number;
	message: any;
}

// one of the statuses emitted in BroadcasterStatus above
export enum BroadcasterStatusType {
	Connected = "Connected", // indicates all channels have been successfully subscribed to as requested
	Trouble = "Trouble", // indicates trouble with the network or one or more subscriptions, should be a temporary state
	Failed = "Failed", // indicates some channels could not be subscribed to, and client action is required to correct this
	Offline = "Offline", // indicates the network is currently offline, so messages won't be received
	Reset = "Reset", // indicates that during catching up on history, there are too many messages or it's been too long...
	// the client should retrieve fresh data from the server as if it is a fresh login
	Aborted = "Aborted", // an aborted state, usually the result of a bad broadcaster token, client must reinitialize

	// the statuses below are used only for testing, normally these are private and black-boxed
	Confirmed = "Confirmed", // indicates subscriptions have been confirmed
	NetworkProblem = "NetworkProblem", // indicates a network problem of some sort
	Queued = "Queued" // indicates channels have been queued for subscribing
}

// internal, maintains map of channels and whether they are yet successfully subscribed
interface SubscriptionMap {
	[key: string]: {
		subscribed: boolean;
		withPresence?: boolean;
	};
}

// the retention time is one month ... to avoid missing messages on the edge, we'll
// not try to catch up if we are within ten minutes of that
const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const THRESHOLD_FOR_CATCHUP = ONE_MONTH - TEN_MINUTES;
const THRESHOLD_BUFFER = 12000;

export class Broadcaster {
	private _broadcasterConnection: BroadcasterConnection | undefined;
	private _subscriptionsPending: boolean = false;
	private _lastSuccessfulSubscription: number = 0;
	private _subscriptions: SubscriptionMap = {};
	private _lastMessageReceivedAt: number = 0;
	private _messageEmitter = new Emitter<{ [key: string]: any }[]>();
	private _statusEmitter = new Emitter<BroadcasterStatus>();
	private _queuedChannels: ChannelDescriptor[] = [];
	private _statusTimeout: NodeJS.Timer | undefined;
	private _lastTick: number = 0;
	private _tickInterval: NodeJS.Timer | undefined;
	private _needConnectedMessage: boolean = false;
	private _hadTrouble: boolean = false;
	private _testMode: boolean = false;
	private _simulateConfirmFailure: boolean = false;
	private _simulateSubscriptionTimeout: boolean = false;
	private _simulateOffline: boolean = false;
	private _aborted: boolean = false;
	private _numResubscribes: number = 0;
	private _debug: (msg: string, info?: any) => void = () => {};
	private _catchingUpSince: number = 0;
	private _activeFailures: string[] = [];
	private _messagesReceived: { [key: string]: number } = {};

	// call to receive status updates
	get onDidStatusChange(): Event<BroadcasterStatus> {
		return this._statusEmitter.event;
	}

	// call to listen for messages
	get onDidReceiveMessages(): Event<{ [key: string]: any }[]> {
		return this._messageEmitter.event;
	}

	constructor(
		private readonly _api: ApiProvider,
		private readonly _proxyAgent: HttpsProxyAgent | undefined
	) {}

	// initialize BroadcasterConnection
	async initialize(options: BroadcasterInitializer): Promise<Disposable> {
		this._debug(`Broadcaster initializing...`);
		if (options.debug) {
			this._debug = options.debug;
		}

		if (options.socketCluster) {
			const socketClusterConnection = new SocketClusterConnection();
			await socketClusterConnection.initialize({
				host: options.socketCluster.host,
				port: options.socketCluster.port,
				authKey: options.authKey,
				userId: options.userId,
				onMessage: this.onMessage.bind(this),
				onStatus: this.onStatus.bind(this),
				debug: this._debug
			});
			this._broadcasterConnection = socketClusterConnection;
		} else {
			const pubnubConnection = new PubnubConnection();
			await pubnubConnection.initialize({
				authKey: options.authKey,
				userId: options.userId,
				subscribeKey: options.pubnubSubscribeKey!,
				proxyAgent: this._proxyAgent,
				onMessage: this.onMessage.bind(this),
				onStatus: this.onStatus.bind(this),
				debug: this._debug
			});
			this._broadcasterConnection = pubnubConnection;
		}
		this._lastMessageReceivedAt = options.lastMessageReceivedAt || 0;
		this._testMode = options.testMode || false;
		this._aborted = false;
		this._numResubscribes = 0;

		this.startTicking();

		return {
			dispose: () => {
				this.unsubscribeAll();
				if (this._broadcasterConnection) {
					this._broadcasterConnection.disconnect();
				}
			}
		};
	}

	// subscribe to the passed channels
	subscribe(channels: (ChannelDescriptor | string)[]) {
		this._debug("Request to subscribe to channels", channels);
		if (this._aborted) {
			this._debug("Broadcaster Connection is aborted");
			return this.emitStatus(BroadcasterStatusType.Aborted);
		}
		const channelDescriptors: ChannelDescriptor[] = this.normalizeChannelDescriptors(channels);
		// while processing subscriptions, we hold off accepting new subscriptions until processing is complete,
		// in the meantime, queue them up ... we'll drain the queue when we've successfully subscribed
		// to the current channels being processed
		if (this._subscriptionsPending) {
			this._debug("Subscriptions are pending, channels will be queued");
			this.queueChannels(channelDescriptors);
		} else {
			this.subscribeToChannels(channelDescriptors);
		}
	}

	// unsubscribe to the passed channels
	unsubscribe(channels: string[]) {
		this._debug("Request to unsubscribe from these channels", channels);
		this.removeChannels(channels);
	}

	// turn every channel, even if specified by channel name, into a ChannelDescriptor
	private normalizeChannelDescriptors(
		channels: (ChannelDescriptor | string)[]
	): ChannelDescriptor[] {
		const normalizedChannels: ChannelDescriptor[] = [];
		channels.forEach(channel => {
			if (typeof channel === "string") {
				if (channel.length > 0) {
					normalizedChannels.push({ name: channel });
				}
			} else if (channel.name.length > 0) {
				normalizedChannels.push(channel);
			}
		});
		return normalizedChannels;
	}

	// we're not in a position to subscribe to these channels, queue them up for later
	private queueChannels(channels: ChannelDescriptor[]) {
		if (this._testMode) {
			this.emitStatus(BroadcasterStatusType.Queued, channels.map(channel => channel.name));
		}
		this._debug("Queueing " + channels);
		this._queuedChannels.push(...channels);
	}

	// a request was made to subscribe to some channels but we weren't ready to handle them,
	// now we are, so drain the queue and subscribe to those channels
	private drainQueue() {
		const channels = this._queuedChannels;
		if (channels.length) {
			this._debug("Draining subscription queue", channels);
		}
		this._queuedChannels = [];
		this.subscribeToChannels(channels);
	}

	// start a ticking clock ... we tick once per second, but if we detect a gap in ticks of
	// longer than 10 seconds, that typically means a computer put on standby or a laptop close ...
	// in this case, the tick gap is usually our quickest way of detecting that we may have
	// some catching up to do once the network connection is restored
	private startTicking() {
		this._tickInterval = setInterval(this.tick.bind(this), 1000);
	}

	// one tick of the clock, if longer than 10 seconds, assume a network "hiccup" of some kind
	private tick() {
		const now = Date.now();
		if (this._lastTick > 0 && now - this._lastTick > 10000) {
			this._debug(`Long tick detected (${now - this._lastTick})`);
			this.netHiccup();
		}
		this._lastTick = now;
	}

	// for test purposes, simulate a long tick (since we can't physically close a laptop!)
	simulateLongTick() {
		clearInterval(this._tickInterval!);
		delete this._tickInterval;
		setTimeout(this.startTicking.bind(this), 11000);
	}

	simulateOffline(doSimulate?: boolean) {
		this._simulateOffline = doSimulate || typeof doSimulate === "undefined";
	}

	// when a message is received...
	private onMessage(event: MessageEvent) {
		if (this._simulateOffline) {
			// simulating offline condition, ignore messages
			return;
		}
		// track the last time a message was received, each time we encounter a disconnected situation,
		// we'll fetch the message history from this point going forward
		this._debug("Broadcaster message received at", event.receivedAt);
		if (event.receivedAt > this._lastMessageReceivedAt && !this._subscriptionsPending) {
			this._lastMessageReceivedAt = event.receivedAt;
			this._debug("_lastMessageReceivedAt updated");
		}

		// we avoid sending duplicate messages up the chain by maintaining a list of the messages
		// we've already received, dropping duplicates to the floor
		const { messageId } = event.message;
		if (!messageId || !this._messagesReceived[messageId]) {
			if (messageId) {
				this._messagesReceived[messageId] = Date.now();
			}
			this.emitMessages([event.message]);
		}
		this.cleanUpMessagesReceived();
	}

	// simulate a subscription timeout on the next subscription event, for testing
	simulateSubscriptionTimeout() {
		this._simulateSubscriptionTimeout = true;
	}

	onStatus(status: BroadcasterStatus) {
		switch (status.status) {
			case BroadcasterStatusType.Connected:
				if (!this._simulateSubscriptionTimeout) {
					// a successful subscription of certain channels
					this.setConnected(status.channels!);
				} else {
					this._simulateSubscriptionTimeout = false;
				}
				return;
			case BroadcasterStatusType.NetworkProblem:
				return this.netHiccup();

			case BroadcasterStatusType.Failed:
				return this.subscriptionFailure(status.channels!);

			case BroadcasterStatusType.Reset:
				return this.reset();

			default:
				this._statusEmitter.fire(status);
		}
	}

	// for testing purposes, simulate a network error
	simulateNetError(delay: number = 0) {
		setTimeout(() => {
			this.onStatus({
				status: BroadcasterStatusType.NetworkProblem
			});
		}, delay);
	}

	// subscribe to these channels
	private subscribeToChannels(channels: ChannelDescriptor[]) {
		// add them as unsubscribed, then subscribe to unsubscribed channels
		const numAdded = this.addChannels(channels);
		if (numAdded > 0) {
			// this says we need to notify the client when we get fully connected
			this._needConnectedMessage = true;
		}
		this._debug("Channels were added, ensuring subscription to all channels...");
		this.subscribeAll();
	}

	// subscribe to all requested channels that we are not yet subscribed to
	private subscribeAll() {
		const channels = this.getUnsubscribedChannels();
		this._debug("Unsubscribed channels are", channels);
		if (channels.length === 0) {
			// no unsubscribed channels, just say we're fully subscribed
			this._debug("No unsubscribed channels, we are fully subscribed");
			return this.subscribed();
		}

		// split into channels that require presence updates and those that don't, and
		// make a separate call to subscribe for each
		const channelsWithPresence: string[] = [];
		const channelsWithoutPresence: string[] = [];
		channels.forEach(channel => {
			if (this._subscriptions[channel].withPresence) {
				channelsWithPresence.push(channel);
			} else {
				channelsWithoutPresence.push(channel);
			}
			// remove this channel from list of active failures, since we are trying again
			const index = this._activeFailures.indexOf(channel);
			if (index !== -1) {
				this._activeFailures.splice(index, 1);
			}
		});
		if (channelsWithPresence.length > 0) {
			this._debug("Broadcaster subscribing (with presence) to", channelsWithPresence);
			this._broadcasterConnection!.subscribe(channelsWithPresence, { withPresence: true });
		}
		if (channelsWithoutPresence.length > 0) {
			this._debug("Broadcaster subscribing to", channelsWithoutPresence);
			this._broadcasterConnection!.subscribe(channelsWithoutPresence);
		}

		// it sucks that we don't get a direct response when we try to
		// subscribe to channels ... when we get a failure, we're not told which channels
		// failed ... so avoid race condition problems by explicitly timing out if we
		// don't receive a success message
		if (!this._statusTimeout) {
			this._debug("Broadcaster subscriptions timing out in 5s...");
			this._statusTimeout = setTimeout(this.subscriptionTimeout.bind(this), 5000);
		}
	}

	// add channels to our list of channels we know we need to subscribe to, mark them
	// as unsubscribed unless we already know about them
	private addChannels(channels: ChannelDescriptor[]): number {
		let numAdded = 0;
		for (const channel of channels) {
			if (!this._subscriptions[channel.name]) {
				this._subscriptions[channel.name] = {
					subscribed: false,
					withPresence: channel.withPresence || false
				};
				numAdded++;
				this._subscriptionsPending = true;
			}
		}
		return numAdded;
	}

	// set the given channels as successfully subscribed to, and if we're subscribed to
	// all channels that have been requested, catch up on any missed history and emit
	// a Connected event when done
	private setConnected(channels: string[]) {
		this._debug("These channels are connected", channels);
		const newlyConnected: string[] = [];
		for (const channel of channels) {
			if (!this._subscriptions[channel].subscribed) {
				this._subscriptions[channel].subscribed = true;
				newlyConnected.push(channel);
			}
		}
		if (this.getUnsubscribedChannels().length === 0) {
			this._debug("No more unsubscribed channels");
			clearTimeout(this._statusTimeout!);
			delete this._statusTimeout;
		}
		this._debug("Catching up on these channels", newlyConnected);
		this.catchUp(newlyConnected);
	}

	// force-set the last message received timestamp, for testing catch-up
	setLastMessageReceivedAt(lastMessageReceivedAt: number) {
		this._lastMessageReceivedAt = lastMessageReceivedAt;
	}

	// catch up on missed history, while disconnected
	private async catchUp(channels: string[]) {
		// catch up since the last message received, or, if we are caught in a loop
		// of trying to catch up already, continue to catch up from that point
		let since = 0;
		if (this._catchingUpSince > 0) {
			since = this._catchingUpSince;
			this._debug(`Already catching up since ${this._catchingUpSince}`);
		} else if (this._lastMessageReceivedAt > 0) {
			since = this._lastMessageReceivedAt - THRESHOLD_BUFFER;
			this._debug(`Last message was recevied at ${this._lastMessageReceivedAt}`);
		}
		if (!since) {
			// assume a fresh session, with no catch up necessary
			this._debug("No messages have been received yet, assume fresh session");
			this._lastMessageReceivedAt = Date.now();
			return this.subscribed();
		}
		if (Date.now() - since > THRESHOLD_FOR_CATCHUP) {
			// if it's been too long, we don't want to process a whole ton of messages,
			// and in any case we only retain messages for one month ... so better to
			// force the client to initiate a fresh session
			this._debug("Been away for too long, forcing reset");
			this._catchingUpSince = 0;
			return this.reset();
		}

		if (channels.length === 0) {
			this._debug("No channels to catch up with");
			if (this.getUnsubscribedChannels().length === 0) {
				this._debug("And no channels at all, no catch-up is needed");
				// if no channels, we just assume we're fully subscribed
				this._catchingUpSince = 0;
				this.subscribed();
			}
			return;
		}

		// fetch history since the last message received
		let historyOutput: BroadcasterHistoryOutput;
		try {
			this._debug(`Fetching history since ${since} for`, channels);
			historyOutput = await this._broadcasterConnection!.fetchHistory({
				channels,
				since,
				debug: this._debug
			});
		} catch (error) {
			// this is bad ... if we can't catch up on history, we'll start
			// with a clean slate and try to resubscribe all over again
			error = error instanceof Error ? error.message : error;
			this._debug("Fetch history error, resubscribing...", error);
			this.emitTrouble();
			return this.resubscribe(channels);
		}

		if (historyOutput.reset) {
			this._debug("Too much history, forcing reset");
			// if in fetching history we found there were too many messages, we don't
			// want to over-burden the client with processing, better just to force
			// a fresh session
			return this.reset();
		} else if (historyOutput.messages && historyOutput.messages.length > 0) {
			// emit all messages found and update to timestamp of last message received
			this._lastMessageReceivedAt = historyOutput.timestamp!;
			this._debug(
				`${historyOutput.messages.length} messages received from history`,
				historyOutput.messages
			);
			this._debug(`_lastMessageReceivedAt updated to ${historyOutput.timestamp}`);
			this.emitMessages(historyOutput.messages);
		}

		// nothing left to do ... we are successfully subscribed to all channels!
		this._debug("Caught up!");
		this._catchingUpSince = 0;
		this.subscribed();
	}

	// we detected a network hiccup of some kind, detect whether we are offline,
	// and if so, go into a waiting mode, otherwise confirm our subscriptions are still
	// in good standing
	private async netHiccup() {
		this._subscriptionsPending = true;
		if (this._testMode) {
			this.emitStatus(BroadcasterStatusType.NetworkProblem);
		}
		this._debug("Network hiccup");
		if (this._activeFailures.length > 0) {
			this._debug("There are active failures in progress, ignore network hiccup");
		} else {
			this._debug("Confirm subscriptions...");
			this.confirmSubscriptions();
		}
	}

	// simulate a failure to confirm subscriptions, for testing purposes
	simulateConfirmFailure(doSimulate?: boolean) {
		this._simulateConfirmFailure = doSimulate || typeof doSimulate === "undefined";
	}

	// confirm our subscriptions are in good standing by calling Pubnub's hereNow(),
	// which tells us which users are subscribed to which channels ... make sure
	// we're in all the expected channels, and if we aren't, resubscribe to them
	private async confirmSubscriptions() {
		const channels = this.getSubscribedChannels();
		if (channels.length === 0) {
			// no subscribed channels to worry about, proceed through the state machine
			// to a subscribed state again
			this._debug("No subscribed channels to confirm, assume we are fully subscribed");
			return this.subscribed();
		}

		let troubleChannels;
		if (this._simulateConfirmFailure) {
			this._debug("Simulating a confirm failure");
			troubleChannels = [...channels];
		}
		else {
			troubleChannels = await this._broadcasterConnection!.confirmSubscriptions(channels);
		}
		if (troubleChannels.length > 0) {
			// let the client know we're experiencing difficulty, and attempt to resubscribe to
			// the channels in question
			this._debug("Failed to confirm all subscriptions, resubscribing...");
			this.emitTrouble(troubleChannels);
			this.resubscribe(troubleChannels);
		} else {
			if (this._testMode) {
				this.emitStatus(BroadcasterStatusType.Confirmed);
			}
			// seems like we're good, let's make sure we didn't miss anything by catching up on
			// message history
			this._debug("Subscriptions confirmed, reconnect and catch up...");
			this._broadcasterConnection!.reconnect();
			this.catchUp(this.getSubscribedChannels());
		}
	}

	// unsubscribe to all channels and stop listening to messages and status updates (clean up)
	private unsubscribeAll() {
		const channels = this.getSubscribedChannels();
		this._debug("Broadcaster unsubscribing", channels);
		this._broadcasterConnection!.unsubscribe(channels);
		this._subscriptions = {};
		if (this._tickInterval) {
			clearInterval(this._tickInterval);
		}
		if (this._statusTimeout) {
			clearTimeout(this._statusTimeout!);
		}
	}

	// we timed out trying to successfully subscribe to one or more channels, enter into a failure
	// mode, ask the api server to explicitly grant us subscription access to those channels,
	// and try again
	private async subscriptionTimeout() {
		delete this._statusTimeout;
		const failedChannels = this.getUnsubscribedChannels();
		this._debug("Subscription timed out for", failedChannels);
		await this.subscriptionFailure(failedChannels);
	}

	// we never successfully subscribed to one or more channels requested, enter into a failure
	// mode, ask the api server to explicitly grant us subscription access to those channels,
	// and try again
	private async subscriptionFailure(failedChannels: string[]) {
		const channels = failedChannels.filter(channel => !this._activeFailures.includes(channel));
		if (channels.length === 0) {
			this._debug("Already handling subscription failures, ignoring", failedChannels);
			return;
		}
		this._activeFailures = [...this._activeFailures, ...channels];
		this.emitTrouble(channels);

		// if we have been granted access by the API server to all channels, but we haven't
		// actually subscribed to any channels, we'll retry 10 times ... after that, we
		// emit a total failure and stop accepting subscription requests ... this is the
		// only way to abort an infinite loop if the broadcaster token was just plain wrong
		if (
			this.getSubscribedChannels().length === 0 &&
			this._lastSuccessfulSubscription === 0
		) {
			if (this._numResubscribes >= 10) {
				this._debug(
					"All subscriptions so far have failed after 10 retries, going into aborted mode..."
				);
				this._aborted = true;
				this.unsubscribeAll();
				return this.emitStatus(BroadcasterStatusType.Aborted);
			}
		}

		if (channels.length === 0) {
			this.subscribed();
		} else {
			const interval = this.getThrottleInterval();
			this._debug(`Resubscribing in ${interval} ms...`);
			setTimeout(() => {
				this.resubscribe(channels);
			}, interval);
		}
	}

	// we're finally subscribed to all channels requested, and are caught up on messages
	private subscribed() {
		// if there are more channels waiting to be subscribed to in the queue, drain the
		// queue and subscribe to those channels, otherwise simply emit a Connected event,
		// indicating we're good to go
		if (this._queuedChannels.length > 0) {
			this._debug(
				"Successfully subscribed, but there are additional subscriptions in queue, draining queue..."
			);
			this.drainQueue();
		} else {
			this._activeFailures = [];
			this._subscriptionsPending = false;
			if (this.getSubscribedChannels().length > 0) {
				this._debug("Subscription successful", this.getSubscribedChannels());
				this._lastSuccessfulSubscription = Date.now();
				this._numResubscribes = 0;
			}
			// we only need to emit the message that we are connected under two conditions:
			// either the client added channels (so they need to know they subscribed successfully),
			// or we encountered network trouble and told them about it (with emitTrouble()),
			// so they need to know we resubscribed successfully
			if (this._needConnectedMessage) {
				this.emitConnected();
			}
		}
	}

	// emit a status update to the client, with channels of interest optionally specified
	private emitStatus(status: BroadcasterStatusType, channels?: string[], reconnected?: boolean) {
		this._debug(`Emitting status ${status}`, channels);
		this._statusEmitter.fire({
			status: status,
			channels: channels,
			reconnected
		});
	}

	// emit a Connected event, letting the client know about all the channels we're now
	// subscribed to
	private emitConnected() {
		const channels = this.getAllChannels();
		this.emitStatus(BroadcasterStatusType.Connected, channels, this._hadTrouble);
		this._needConnectedMessage = false;
		this._hadTrouble = false;
	}

	// emit a Trouble event, indicating we're having trouble subscribing to one or more
	// channels, so the client can display something to the user as needed
	private emitTrouble(channels?: string[]) {
		this._debug("We are in trouble");
		// this says we need to notify the client when we get fully connected (again)
		this._hadTrouble = true;
		this._needConnectedMessage = true;
		this.emitStatus(BroadcasterStatusType.Trouble, channels);
	}

	// let the client know we were unable to subscribe to a given set of channels, and
	// moreover that we were unable to even get the server to give us access to those
	// channels ... something is wrong in this case and we'll no longer attempt to
	// subscribe to those channels
	private emitFailures(channels: string[]) {
		this.emitStatus(BroadcasterStatusType.Failed, channels);
	}

	// get all known channels to which we are being asked to subscribe
	private getAllChannels(): string[] {
		return Object.keys(this._subscriptions);
	}

	// get all channels that we are actively subscribed to
	private getSubscribedChannels(): string[] {
		return Object.keys(this._subscriptions).filter(channel => {
			return this._subscriptions[channel].subscribed;
		});
	}

	// get all channels that we are not yet subscribed to
	private getUnsubscribedChannels(): string[] {
		return Object.keys(this._subscriptions).filter(channel => {
			return !this._subscriptions[channel].subscribed;
		});
	}

	// emit an Offline event, indicating we are currently not connected to the network
	private offline() {
		this.emitStatus(BroadcasterStatusType.Offline);
	}

	// resubscribe to all channels
	private resubscribe(channels?: string[]) {
		if (!channels) {
			channels = Object.keys(this._subscriptions);
		}
		this._numResubscribes++;
		this._debug("Set numResubscribes to " + this._numResubscribes);
		channels.forEach(channel => {
			this._subscriptions[channel].subscribed = false;
		});
		this._debug("Resubscribing to", channels);
		// this._pubnub!.unsubscribeAll();
		this._subscriptionsPending = true;
		// also drain the queue and add any queued channels to the list, since we're
		// starting from scratch on all of them anyway
		this.drainQueue();
	}

	// emit a Reset event, indicating to the client that we have too many messages to
	// fetch to catch up on messages, and that it would be better for the client to
	// initiate a fresh session ... in doing this, we'll unsubscribe to all channels,
	// since it is expected that the client will initiate new subscriptions after
	// resetting the session
	private reset() {
		this.unsubscribeAll();
		this.emitStatus(BroadcasterStatusType.Reset);
	}

	// remove the given set of channels from our list of channels to which we are
	// trying to subscribe
	private removeChannels(channels: string[]) {
		this._broadcasterConnection!.unsubscribe(channels);
		for (const channel of channels) {
			delete this._subscriptions[channel];
		}
	}

	// to throttle resubscribe attempts, determine the next interval to wait until resubscribe
	private getThrottleInterval() {
		if (this._numResubscribes < 10) {
			return 0;
		} else if (this._numResubscribes < 100) {
			return 1000;
		} else {
			return 60000;
		}
	}

	// emit messages to the client
	private emitMessages(messages: { [key: string]: any }[]) {
		this._messageEmitter.fire(messages);
	}

	// clean up our ongoing tracking of messages received
	private cleanUpMessagesReceived() {
		// we'll clean up any record of messages received more than ten minutes old
		const cutoff = Date.now() - 10 * 60 * 1000;
		Object.keys(this._messagesReceived).forEach(messageId => {
			if (this._messagesReceived[messageId] < cutoff) {
				delete this._messagesReceived[messageId];
			}
		});
	}
}
