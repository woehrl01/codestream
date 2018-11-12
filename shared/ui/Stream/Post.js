import React from "react";
import * as Path from "path";
import { connect } from "react-redux";
import { injectIntl } from "react-intl";
import createClassString from "classnames";
import Headshot from "./Headshot";
import Icon from "./Icon";
import Timestamp from "./Timestamp";
import PostDetails from "./PostDetails";
import RetrySpinner from "./RetrySpinner";
import { retryPost, cancelPost, showCode } from "./actions";
import ContentEditable from "react-contenteditable";
import Button from "./Button";
import Menu from "./Menu";
import EmojiPicker from "./EmojiPicker";
import Tooltip from "./Tooltip";
import Debug from "./Debug";
import { getById } from "../reducers/repos";
import { getPost } from "../reducers/posts";
import { getCodemark } from "../reducers/codemarks";
import { markdownify, emojify } from "./Markdowner";
import hljs from "highlight.js";
import _ from "underscore";
import { reactToPost, setPostStatus } from "./actions";
import { safe } from "../utils";

// let renderCount = 0;
class Post extends React.Component {
	state = {
		emojiOpen: false,
		emojiTarget: null,
		menuOpen: false,
		menuTarget: null,
		authorMenuOpen: false,
		warning: null
	};

	componentDidMount() {
		if (this.props.didTriggerThread) {
			this.showCode(true);
		}
	}

	shouldComponentUpdate(nextProps, nextState) {
		const postChanged = true; //  nextProps.post.version !== this.props.post.version;

		const propsChanged = Object.entries(this.props).some(([prop, value]) => {
			return !["userNames", "post"].includes(prop) && value !== this.props[prop];
		});
		const userNamesChanged = !_.isEqual(this.props.userNames, nextProps.userNames);
		const stateChanged = !_.isEqual(this.state, nextState);
		const shouldUpdate = propsChanged || userNamesChanged || postChanged || stateChanged;
		return shouldUpdate;
	}

	componentDidUpdate(prevProps, _prevState) {
		const editStateToggledOn = this.props.editing && !prevProps.editing;
		if (editStateToggledOn) {
			document.getElementById(this.getEditInputId()).focus();
		}

		if (!prevProps.didTriggerThread && this.props.didTriggerThread) {
			this.showCode(true);
		}
	}

	handleClickCodeBlock = event => {
		event.stopPropagation();
		this.showCode();
	};

	async showCode(enteringThread = false) {
		const { post, hasMarkers, codemark } = this.props;
		const marker = hasMarkers && codemark.markers[0];
		if (marker) {
			if (marker.repoId) {
				const status = await this.props.showCode(this.props.post, enteringThread);
				if (status === "SUCCESS") {
					this.setState({ warning: null });
				} else {
					this.setState({ warning: status });
				}
			} else this.setState({ warning: "NO_REMOTE" });
		}
	}

	resubmit = () => this.props.retryPost(this.props.post.id);

	cancel = () => this.props.cancelPost(this.props.post.id);

	getWarningMessage() {
		const { intl } = this.props;
		switch (this.state.warning) {
			case "NO_REMOTE": {
				const message = intl.formatMessage({
					id: "codeBlock.noRemote",
					defaultMessage: "This code does not have a remote URL associated with it."
				});
				const learnMore = intl.formatMessage({ id: "learnMore" });
				return (
					<span>
						{message}{" "}
						<a href="https://help.codestream.com/hc/en-us/articles/360013410551">{learnMore}</a>
					</span>
				);
			}
			case "FILE_NOT_FOUND": {
				return (
					<span>
						{intl.formatMessage({
							id: "codeBlock.fileNotFound",
							defaultMessage: "You don’t currently have this file in your repo."
						})}
					</span>
				);
			}
			case "REPO_NOT_IN_WORKSPACE": {
				return (
					<span>
						{intl.formatMessage(
							{
								id: "codeBlock.repoMissing",
								defaultMessage: "You don’t currently have the {repoName} repo open."
							},
							{ repoName: this.props.repoName }
						)}
					</span>
				);
			}
			case "UNKNOWN_LOCATION":
			default: {
				return (
					<span>
						{intl.formatMessage({
							id: "codeBlock.locationUnknown",
							defaultMessage: "Unknown code block location."
						})}
					</span>
				);
			}
		}
	}

	renderCode(marker) {
		const path = marker.file;
		let extension = Path.extname(path).toLowerCase();
		if (extension.startsWith(".")) {
			extension = extension.substring(1);
			if (extension === "tsx") extension = "jsx"; // Placeholder until https://github.com/highlightjs/highlight.js/pull/1663 get's merged
		}
		let codeHTML;
		if (extension) {
			try {
				codeHTML = hljs.highlight(extension, marker.code).value;
			} catch (e) {
				/* the language for that file extension may not be supported */
				codeHTML = hljs.highlightAuto(marker.code).value;
			}
		} else codeHTML = hljs.highlightAuto(marker.code).value;

		return <div className="code" dangerouslySetInnerHTML={{ __html: codeHTML }} />;
	}

	render() {
		if (this.props.deactivated) return null;

		// console.log(renderCount++);
		const { post, showStatus, showAssigneeHeadshots, hasMarkers, codemark } = this.props;
		const { menuOpen, authorMenuOpen, menuTarget } = this.state;

		const headshotSize = this.props.headshotSize || 36;

		const mine = post.creatorId === this.props.currentUserId;
		const systemPost = post.creatorId === "codestream";
		const color = codemark && codemark.color;
		const type = codemark && codemark.type;
		const title = codemark && codemark.title;

		// if (post.title && post.title.match(/assigned/)) console.log(post);

		const postClass = createClassString({
			post: true,
			mine: mine,
			hover: menuOpen || authorMenuOpen,
			editing: this.props.editing,
			"system-post": systemPost,
			"has-status": showStatus,
			unread: this.props.unread,
			"new-separator": this.props.newMessageIndicator,
			[`thread-key-${this.props.threadKey}`]: true,
			[color]: true,
			collapsed: this.props.collapsed,
			question: type === "question",
			issue: type === "issue",
			trap: type === "trap",
			bookmark: type === "bookmark"
		});

		// console.log(post);
		let codeBlock = null;
		if (hasMarkers) {
			const noRepo = !codemark.markers[0].repoId;
			codeBlock = (
				<div
					className="code-reference"
					onClick={this.props.showDetails && this.handleClickCodeBlock}
				>
					<div className={createClassString("header", { "no-repo": noRepo })}>
						<span className="file">{codemark.markers[0].file || "-"}</span>
						{this.state.warning && (
							<Tooltip placement="left" title={this.getWarningMessage()}>
								<span className="icon-wrapper">
									<Icon name="info" />
								</span>
							</Tooltip>
						)}
					</div>
					{this.renderCode(codemark.markers[0])}
				</div>
			);
		}

		let parentPost = this.props.replyingTo;
		const parentPostTitle = parentPost && parentPost.codemark && parentPost.codemark.title;
		if (_.isString(parentPost)) parentPost = { text: "a message" };

		let menuItems = [];

		if (!this.props.showDetails) {
			const threadLabel = parentPost || post.numReplies > 0 ? "View Thread" : "Start a Thread";
			menuItems.push({ label: threadLabel, action: "make-thread" });
		}
		// menuItems.push({ label: "Add Reaction", action: "add-reaction" });

		menuItems.push({ label: "Mark Unread", action: "mark-unread" });
		menuItems.push({ label: "Quote", action: "quote" });
		// { label: "Add Reaction", action: "add-reaction" },
		// { label: "Pin to Stream", action: "pin-to-stream" }

		if (mine) {
			menuItems.push(
				{ label: "-" },
				{ label: "Edit Comment", action: "edit-post" },
				{ label: "Delete Comment", action: "delete-post" }
			);
		}

		let authorMenuItems = [];
		// if (this.state.authorMenuOpen) {
		authorMenuItems.push({
			fragment: (
				<div className="headshot-popup">
					<Headshot size={144} person={post.author} />
					<div className="author-details">
						<div className="author-username">@{post.author.username}</div>
						<div className="author-fullname">{post.author.fullName}</div>
					</div>
				</div>
			)
		});
		if (mine) {
			authorMenuItems.push({ label: "Edit Headshot", action: "edit-headshot" });
		} else {
			if (this.props.canLiveshare)
				authorMenuItems.push({ label: "Invite to Live Share", action: "live-share" });
			authorMenuItems.push({ label: "Direct Message", action: "direct-message" });
		}

		const showIcons = !systemPost && !post.error;

		return (
			<div
				className={postClass}
				id={post.id}
				data-seq-num={post.seqNum}
				thread={post.parentPostId || post.id}
				ref={ref => (this._div = ref)}
			>
				{showStatus && this.renderStatus()}
				{showAssigneeHeadshots && this.renderAssigneeHeadshots()}
				{showIcons && this.renderIcons()}
				{menuOpen && <Menu items={menuItems} target={menuTarget} action={this.handleSelectMenu} />}
				{authorMenuOpen && (
					<Menu
						items={authorMenuItems}
						target={menuTarget}
						action={this.handleSelectMenu}
						align="left"
					/>
				)}
				<Debug object={post} placement="top">
					<Headshot
						size={headshotSize}
						person={post.author}
						mine={mine}
						onClick={this.handleHeadshotClick}
					/>
				</Debug>

				<span className="author" ref={ref => (this._authorDiv = ref)}>
					{post.author.username}
					{this.renderEmote(post)}
				</span>
				{post.error ? (
					<RetrySpinner callback={this.resubmit} cancel={this.cancel} />
				) : (
					<Timestamp time={post.createdAt} />
				)}
				{parentPost && (
					<div className="replying-to">
						<span>reply to</span> <b>{(parentPostTitle || parentPost.text).substr(0, 80)}</b>
					</div>
				)}
				{post.creatorId === "codestream" && (
					<div className="replying-to">
						<span>only visible to you</span>
					</div>
				)}
				<div className="body">
					{this.renderTitle(post)}
					{(this.props.editing || post.text.length > 0) && (
						<div className="text">
							{this.props.collapsed && !title && this.renderTypeIcon(post)}
							{this.renderText(post)}
							{!this.props.editing && post.hasBeenEdited && (
								<span className="edited">(edited)</span>
							)}
							{this.renderAssignees(post)}
							{this.renderCodeBlockFile(post)}
						</div>
					)}
					{codeBlock}
					{this.renderAttachments(post)}
					{this.props.showDetails && !this.state.warning && (
						<PostDetails post={post} currentCommit={this.props.currentCommit} />
					)}
				</div>
				{this.renderReactions(post)}
				{this.renderReplyCount(post)}
			</div>
		);
	}

	renderAttachments = post => {
		if (post.files && post.files.length) {
			return post.files.map(file => {
				// console.log(file);
				//<img src={preview.url} width={preview.width} height={preview.height} />
				const { type, url, name, title, preview } = file;
				if (type === "image") {
					return (
						<div className="thumbnail">
							<a href={url}>{title}</a>
						</div>
					);
				} else if (type === "post") {
					return (
						<div className="external-post">
							<a href={url}>{title}</a>
							<div className="preview" dangerouslySetInnerHTML={{ __html: preview }} />
						</div>
					);
				} else {
					return (
						<div className="attachment">
							<a href={url}>{title}</a>
							<pre>
								<code>{preview}</code>
							</pre>
						</div>
					);
				}
			});
		}
		return null;
	};

	renderReplyCount = post => {
		let message = null;
		if (
			!this.props.alwaysShowReplyCount &&
			(this.props.showDetails || !post.numReplies || this.props.collapsed)
		)
			return null;

		const numReplies = post.numreplies || "0";

		const { codemark } = this.props;
		const type = codemark && codemark.type;
		switch (type) {
			case "question":
				message = numReplies === 1 ? "1 Answer" : `${numReplies} Answers`;
				break;
			default:
				message = numReplies === 1 ? "1 Reply" : `${numReplies} Replies`;
				break;
		}
		return (
			<a className="num-replies" onClick={this.goToThread}>
				{message}
			</a>
		);
	};

	goToThread = () => {
		this.props.action("goto-thread", this.props.post);
	};

	toggleStatus = () => {
		const { post, codemark } = this.props;
		const status = codemark && codemark.status;
		if (status === "closed") this.reopenIssue();
		else this.closeIssue();
	};

	submitReply = text => {
		const { post, action } = this.props;
		const forceThreadId = post.parentPostId || post.id;
		action("submit-post", post, { forceStreamId: post.streamId, forceThreadId, text });
	};

	closeIssue = e => {
		this.props.setPostStatus(this.props.post, "closed");
		this.submitReply("/me closed this issue");
	};

	reopenIssue = e => {
		this.props.setPostStatus(this.props.post, "open");
		this.submitReply("/me reopened this issue");
		// this.props.action("submit-post", this.props.post, { postStreamId, threadId, text: "/me reopened this issue" });
	};

	renderTypeIcon = post => {
		const { codemark } = this.props;
		let icon = null;
		const type = codemark && codemark.type;
		switch (type) {
			case "question":
				icon = <Icon name="question" className="type-icon" />;
				break;
			case "bookmark":
				icon = <Icon name="bookmark" className="type-icon" />;
				break;
			case "trap":
				icon = <Icon name="trap" className="type-icon" />;
				break;
			case "issue":
				icon = <Icon name="issue" className="type-icon" />;
				break;
			default:
				icon = <Icon name="comment" className="type-icon" />;
		}
		return icon;
	};

	renderTitle = post => {
		const { codemark } = this.props;
		const icon = this.renderTypeIcon(post);
		const title = codemark && codemark.title;
		if (title)
			return (
				<div className="title">
					{icon} {this.renderTextLinkified(title)}
					{this.renderCodeBlockFile(post)}
				</div>
			);
		else return null;
	};

	renderAssignees = post => {
		const { collapsed, codemark } = this.props;

		if (collapsed) return null;

		const assignees = codemark ? codemark.assignees || [] : [];

		if (assignees.length == 0) return null;
		if (!this.props.teammates) return null;

		return (
			<div className="assignees">
				<b>Assignees</b>
				<br />
				{assignees
					.map(userId => {
						const person = this.props.teammates.find(user => user.id === userId);
						return person.username;
					})
					.join(", ")}

				<br />
			</div>
		);
	};

	renderCodeBlockFile = post => {
		const { collapsed, showFileAfterTitle, hasMarkers, codemark } = this.props;

		const marker = hasMarkers ? codemark.markers[0] || {} : {};

		if (!collapsed || !showFileAfterTitle || !marker.file) return null;
		return <span className="file-name">{marker.file}</span>;
	};

	renderStatus = () => {
		// console.log("STATUS IS: ", this.props.status);
		const { post } = this.props;
		const status = (codemark && codemark.status) || "open";
		// const status = this.props.post.status || "open";

		const statusClass = createClassString({
			"status-button": true,
			checked: status === "closed"
		});

		return (
			<div className="align-far-left">
				<div className={statusClass} onClick={this.toggleStatus}>
					<Icon name="check" className="check" />
				</div>
			</div>
		);
	};

	renderAssigneeHeadshots = () => {
		const { post } = this.props;
		const assignees = codemark ? codemark.assignees || [] : [];

		if (assignees.length == 0) return null;

		return (
			<div className="align-far-right">
				{assignees.map(userId => {
					const person = this.props.teammates.find(user => user.id === userId);
					return (
						<Tooltip key={userId} title={"hi"} placement="above">
							<Headshot size={18} person={person} />
						</Tooltip>
					);
				})}
			</div>
		);
	};

	renderIcons = () => {
		if (this.props.collapsed) return null;
		// return (
		// 	<div className="align-right">
		// 		<Tooltip title="View Details" placement="above">
		// 			<Icon name="chevron-right" className="chevron-right" onClick={this.goToThread} />
		// 		</Tooltip>
		// 	</div>
		// );
		else
			return (
				<div className="align-right">
					<Tooltip title="Add Reaction" placement="bottomRight">
						<span>
							<Icon name="smiley" className="smiley" onClick={this.handleReactionClick} />
						</span>
					</Tooltip>
					{this.state.emojiOpen && (
						<EmojiPicker addEmoji={this.addReaction} target={this.state.emojiTarget} />
					)}
					<Tooltip title="More Options..." placement="bottomRight">
						<span>
							<Icon name="gear" className="gear" onClick={this.handleMenuClick} />
						</span>
					</Tooltip>
				</div>
			);
	};

	renderEmote = post => {
		const { codemark } = this.props;
		const type = codemark && codemark.type;
		let matches = (post.text || "").match(/^\/me\s+(.*)/);
		if (matches) return <span className="emote">{this.renderTextLinkified(matches[1])}</span>;
		if (type === "question") return <span className="emote">has a question</span>;
		if (type === "bookmark") return <span className="emote">set a bookmark</span>;
		if (type === "issue") return <span className="emote">posted an issue</span>;
		if (type === "trap") return <span className="emote">created a code trap</span>;
		else return null;
	};

	renderText = post => {
		if (this.props.editing) return this.renderTextEditing(post);
		else if ((post.text || "").match(/^\/me\s/)) return null;
		else return this.renderTextLinkified(post.text);
	};

	renderTextLinkified = text => {
		let html;
		if (text == null || text === "") {
			html = "";
		} else {
			const me = this.props.currentUserName.toLowerCase();
			html = markdownify(text).replace(/@(\w+)/g, (match, name) => {
				const nameNormalized = name.toLowerCase();
				if (this.props.userNamesNormalized.has(nameNormalized)) {
					return `<span class="at-mention${nameNormalized === me ? " me" : ""}">${match}</span>`;
				}

				return match;
			});

			if (this.props.q) {
				const matchQueryRegexp = new RegExp(this.props.q, "g");
				html = html.replace(matchQueryRegexp, "<u><b>$&</b></u>");
			}
		}

		return <span dangerouslySetInnerHTML={{ __html: html }} />;
	};

	getEditInputId = () => {
		let id = `input-div-${this.props.post.id}`;
		if (this.props.showDetails) id = `thread-${id}`;
		return id;
	};

	renderTextEditing = post => {
		const id = this.getEditInputId();

		return (
			<div className="edit-post">
				<ContentEditable
					className="native-key-bindings message-input"
					id={id}
					rows="1"
					tabIndex="-1"
					onChange={this.handleOnChange}
					onBlur={this.handleOnBlur}
					html={post.text}
					ref={ref => (this._contentEditable = ref)}
				/>
				<div className="button-group">
					<Button
						id="save-button"
						className="control-button"
						tabIndex="2"
						type="submit"
						loading={this.props.loading}
						onClick={this.handleClickSave}
					>
						Save
					</Button>
					<Button
						id="cancel-button"
						className="control-button cancel"
						tabIndex="2"
						type="submit"
						loading={this.props.loading}
					>
						Cancel
					</Button>
				</div>
			</div>
		);
	};

	addReaction = emoji => {
		this.setState({ emojiOpen: false });
		if (!emoji || !emoji.id) return;

		this.toggleReaction(emoji.id);
	};

	postHasReactionFromUser = emojiId => {
		const { post, currentUserId } = this.props;
		return (
			post.reactions &&
			post.reactions[emojiId] &&
			_.contains(post.reactions[emojiId], currentUserId)
		);
	};

	toggleReaction = (emojiId, event) => {
		let { post } = this.props;

		if (event) event.stopPropagation();

		if (!emojiId) return;

		const value = this.postHasReactionFromUser(emojiId) ? false : true;
		this.props.reactToPost(post, emojiId, value);
	};

	renderReactions = post => {
		const { userNames, currentUserId } = this.props;
		const reactions = post.reactions || {};
		const keys = Object.keys(reactions);
		if (keys.length === 0) return null;
		let atLeastOneReaction = false;
		return (
			<div className="reactions">
				{keys.map(emojiId => {
					const reactors = reactions[emojiId] || [];
					if (reactors.length == 0) return null;
					const emoji = emojify(":" + emojiId + ":");
					const tooltipText =
						reactors.map(id => userNames[id]).join(", ") + " reacted with " + emojiId;
					const className = _.contains(reactors, currentUserId) ? "reaction mine" : "reaction";
					atLeastOneReaction = true;
					return (
						<Tooltip title={tooltipText} key={emojiId} placement="top">
							<div className={className} onClick={event => this.toggleReaction(emojiId, event)}>
								<span dangerouslySetInnerHTML={{ __html: emoji }} />
								{reactors.length}
							</div>
						</Tooltip>
					);
				})}
				{atLeastOneReaction && (
					<Tooltip title="Add Reaction" key="add" placement="top">
						<div className="reaction add-reaction" onClick={this.handleReactionClick}>
							<Icon name="smiley" className="smiley" onClick={this.handleReactionClick} />
						</div>
					</Tooltip>
				)}
			</div>
		);
	};

	handleMenuClick = event => {
		event.stopPropagation();
		this.setState({ menuOpen: !this.state.menuOpen, menuTarget: event.target });
	};

	handleReactionClick = event => {
		event.stopPropagation();
		this.setState({ emojiOpen: !this.state.emojiOpen, emojiTarget: event.target });
	};

	handleHeadshotClick = event => {
		event.stopPropagation();
		this.setState({ authorMenuOpen: !this.state.authorMenuOpen, menuTarget: event.target });
	};

	handleSelectMenu = action => {
		this.props.action(action, this.props.post);
		this.setState({ menuOpen: false, authorMenuOpen: false });
	};
}

const mapStateToProps = (state, props) => {
	const { users } = state;

	// TODO: figure out a way to do this elsewhere

	let index = 1;

	let userNames = {};
	let userNamesNormalized = new Set();

	for (const [userId, user] of Object.entries(users)) {
		user.color = index % 10;
		if (!user.username && user.email) {
			user.username = user.email.replace(/@.*/, "");
		}

		userNames[userId] = user.username;
		if (user.username) {
			userNamesNormalized.add(user.username.toLowerCase());
		}
	}

	const post = getPost(state.posts, props.streamId, props.id);
	if (!post) return { deactivated: true };

	const codemark = getCodemark(state.codemarks, post.codemarkId);

	const repoName =
		(codemark &&
			safe(() => {
				return getById(state.repos, codemark.markers[0].repoId).name;
			})) ||
		"";

	let author = users[post.creatorId];
	if (!author) {
		author = { email: "", fullName: "" };
		if (post.creatorId === "codestream") author.username = "CodeStream";
		else author.username = post.creatorId;
	}

	return {
		userNames,
		userNamesNormalized,
		repoName,
		canLiveshare: state.services.vsls,
		post: { ...post, author }, // pull author out
		hasMarkers: codemark && codemark.markers.length > 0,
		codemark
	};
};

export default connect(
	mapStateToProps,
	{ cancelPost, retryPost, showCode, reactToPost, setPostStatus }
)(injectIntl(Post));
