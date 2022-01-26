"use strict";

import { EventEmitter } from "vscode";
import * as vscode from "vscode";
import { ViewMethodLevelTelemetryCommandArgs } from "commands";
import { Event } from "vscode-languageclient";
import { Strings } from "../system";
import { Container } from "../container";
import { Logger } from "../logger";
import { InstrumentableSymbol, SymbolLocator } from "./symbolLocator";

const languageSpecificExtensions: any = {
	python: "ms-python.python"
};

export class InstrumentationCodeLensProvider implements vscode.CodeLensProvider {
	symbolLocator: SymbolLocator;
	constructor(private template: string) {
		this.symbolLocator = new SymbolLocator();
	}

	private _onDidChangeCodeLenses = new EventEmitter<void>();
	get onDidChangeCodeLenses(): Event<void> {
		return this._onDidChangeCodeLenses.event;
	}

	update(template: string) {
		this.template = template;
		this._onDidChangeCodeLenses.fire();
	}

	public async provideCodeLenses(
		document: vscode.TextDocument,
		token: vscode.CancellationToken
	): Promise<vscode.CodeLens[]> {
		let codeLenses: vscode.CodeLens[] = [];
		let instrumentableSymbols: InstrumentableSymbol[] = [];

		try {
			if (token.isCancellationRequested) {
				return [];
			}
			instrumentableSymbols = await this.symbolLocator.locate(document, token);
		} catch (ex) {
			Logger.warn("provideCodeLenses", {
				error: ex,
				document: document
			});
			return codeLenses;
		}

		try {
			if (!instrumentableSymbols.length) {
				return codeLenses;
			}

			if (token.isCancellationRequested) return [];

			const methodLevelTelemetryRequestOptions = {
				includeAverageDuration: this.template.indexOf("${averageDuration}") > -1,
				includeThroughput: this.template.indexOf("${throughput}") > -1,
				includeErrorRate: this.template.indexOf("${errorsPerMinute}") > -1
			};

			const fileLevelTelemetryResponse = await Container.agent.observability.getFileLevelTelemetry(
				document.fileName,
				document.languageId,
				methodLevelTelemetryRequestOptions
			);

			if (fileLevelTelemetryResponse == null) {
				Logger.log("provideCodeLenses no response", {
					fileName: document.fileName,
					languageId: document.languageId,
					methodLevelTelemetryRequestOptions
				});
				return codeLenses;
			}
			if (
				instrumentableSymbols.length &&
				fileLevelTelemetryResponse.isConnected &&
				!fileLevelTelemetryResponse.newRelicEntityGuid
			) {
				Logger.warn(
					`DEVELOPER: to enable method level metrics, you will need a vscode language-specific extension like ${
						languageSpecificExtensions[document.languageId]
					}`
				);
				return codeLenses;
			}

			if (!fileLevelTelemetryResponse.repo) {
				Logger.warn("provideCodeLenses missing repo");
				return codeLenses;
			}

			if (fileLevelTelemetryResponse.error) {
				if (fileLevelTelemetryResponse.error.type === "NOT_ASSOCIATED") {
					const viewCommandArgs = {
						error: fileLevelTelemetryResponse.error,
						newRelicEntityGuid: fileLevelTelemetryResponse.newRelicEntityGuid,
						repo: fileLevelTelemetryResponse.repo
					};
					const nonAssociatedCodeLens: vscode.CodeLens[] = [
						new vscode.CodeLens(
							new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 1)),
							new InstrumentableSymbolCommand(
								"Click to configure golden signals from New Relic",
								"codestream.viewMethodLevelTelemetry",
								"Associate this repository with an entity from New Relic One so that you can see golden signals right in your editor",
								[JSON.stringify(viewCommandArgs)]
							)
						)
					];
					return nonAssociatedCodeLens;
				}
				return codeLenses;
			}

			// if (!fileLevelTelemetryResponse.hasAnyData) {
			// 	Logger.log("provideCodeLenses no data", {
			// 		fileName: document.fileName,
			// 		languageId: document.languageId,
			// 		methodLevelTelemetryRequestOptions
			// 	});
			// 	return codeLenses;
			// }

			if (token.isCancellationRequested) return [];

			const date = fileLevelTelemetryResponse.lastUpdateDate
				? new Date(fileLevelTelemetryResponse.lastUpdateDate).toLocaleString()
				: "";

			const tooltip = `${
				fileLevelTelemetryResponse.newRelicEntityName
					? `entity: ${fileLevelTelemetryResponse.newRelicEntityName}`
					: ""
			} - ${date ? `since ${date}` : ""}\nClick for more.`;

			const lenses = instrumentableSymbols.map(_ => {
				const throughputForFunction = fileLevelTelemetryResponse.throughput
					? fileLevelTelemetryResponse.throughput.find((i: any) => i.functionName === _.symbol.name)
					: undefined;

				const averageDurationForFunction = fileLevelTelemetryResponse.averageDuration
					? fileLevelTelemetryResponse.averageDuration.find(
							(i: any) => i.functionName === _.symbol.name
					  )
					: undefined;

				const errorRateForFunction = fileLevelTelemetryResponse.errorRate
					? fileLevelTelemetryResponse.errorRate.find((i: any) => i.functionName === _.symbol.name)
					: undefined;

				// if (!throughputForFunction && !averageDurationForFunction && !errorRateForFunction) {
				// 	Logger.debug(`provideCodeLenses no data for ${_.symbol.name}`);
				// 	return undefined;
				// }

				const viewCommandArgs: ViewMethodLevelTelemetryCommandArgs = {
					repo: fileLevelTelemetryResponse.repo,
					codeNamespace: fileLevelTelemetryResponse.codeNamespace!,
					metricTimesliceNameMapping: {
						t: throughputForFunction ? throughputForFunction.metricTimesliceName : "",
						d: averageDurationForFunction ? averageDurationForFunction.metricTimesliceName : "",
						e: errorRateForFunction ? errorRateForFunction.metricTimesliceName : ""
					},
					filePath: document.fileName,
					relativeFilePath: fileLevelTelemetryResponse.relativeFilePath,
					languageId: document.languageId,
					range: _.symbol.range,
					functionName: _.symbol.name,
					newRelicAccountId: fileLevelTelemetryResponse.newRelicAccountId,
					newRelicEntityGuid: fileLevelTelemetryResponse.newRelicEntityGuid,
					methodLevelTelemetryRequestOptions: methodLevelTelemetryRequestOptions
				};

				return new vscode.CodeLens(
					_.symbol.range,
					new InstrumentableSymbolCommand(
						Strings.interpolate(this.template, {
							averageDuration:
								averageDurationForFunction && averageDurationForFunction.averageDuration
									? `${averageDurationForFunction.averageDuration.toFixed(3) || "0.00"}ms`
									: "n/a",
							throughput:
								throughputForFunction && throughputForFunction.requestsPerMinute
									? `${throughputForFunction.requestsPerMinute.toFixed(3) || "0.00"}rpm`
									: "n/a",
							errorsPerMinute:
								errorRateForFunction && errorRateForFunction.errorsPerMinute
									? `${errorRateForFunction.errorsPerMinute.toFixed(3) || "0"}epm`
									: "n/a",
							since: fileLevelTelemetryResponse.sinceDateFormatted,
							date: date
						}),
						"codestream.viewMethodLevelTelemetry",
						tooltip,
						[JSON.stringify(viewCommandArgs)]
					)
				);
			});

			codeLenses = lenses.filter(_ => _ != null) as vscode.CodeLens[];
		} catch (ex) {
			Logger.error(ex, "provideCodeLens", {
				fileName: document.fileName
			});
		}
		return codeLenses;
	}

	public resolveCodeLens(codeLens: vscode.CodeLens, token: vscode.CancellationToken) {
		return token.isCancellationRequested ? undefined : codeLens;
	}
}

class InstrumentableSymbolCommand implements vscode.Command {
	arguments: string[] | undefined;
	constructor(
		public title: string,
		public command: string,
		public tooltip?: string,
		args?: string[] | undefined
	) {
		this.arguments = args;
	}
}
