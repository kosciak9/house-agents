// Contract: Office files sent in the chat are edited in working copies through
// code mode and come back as real files. An uploaded XLSX returns with typed
// literals, working formulas, structural edits and styles. A background
// general subagent edits its own copy of the immutable source; the parent
// delivers its export once the subagent reports back. Uploaded DOCX and PPTX
// likewise return real edited bytes, retaining fragmented Word formatting,
// tables and slide layout, and the originals return byte-for-byte intact.
// The scripted model (`e2e/scripted-model.ts`) makes the tool calls, so this
// tests the harness, not a model's judgement.
// Runs its own bot process on an empty session.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { Model } from "@ironcalc/nodejs";
import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import {
	createPresentationFixture,
	createWordFixture,
	inspectPresentation,
	inspectWord,
} from "./office.ts";
import {
	call,
	codemode,
	SCRIPTED_MODEL,
	say,
	script,
} from "./scripted-model.ts";
import {
	botUsername,
	connectTestUser,
	sendAndWaitForDocument,
	sendDocumentAndWaitForReply,
} from "./telegram/client.ts";

const MINUTE = 60_000;
const XLSX =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Unique per run, so a message from an earlier run never satisfies this one.
const runId = Date.now().toString(36).toUpperCase();

const directory = mkdtempSync(path.join(tmpdir(), "e2e-office-"));
const xlsxSource = `source-${runId}.xlsx`;

let runningBot: RunningBot;
let client: Client;
let bot: string;

// Code mode scripts find files sent in the chat by name.
const FIND_FILE =
	"const file = async (name) => (await tools.file_list({})).find((f) => f.fileName === name);\n";
const quoted = (value: string) => JSON.stringify(value);

/** Sends the file at `filePath`; resolves once the agent has stored it. */
const upload = async (filePath: string) => {
	const received = `RECEIVED ${path.basename(filePath)}`;
	await sendDocumentAndWaitForReply(
		client,
		bot,
		filePath,
		script(say(received)),
		{ matches: (text) => text === received, timeoutMs: MINUTE },
	);
};

/** Reads the XLSX `data` through a file, as IronCalc only opens files. */
const readXlsx = (data: Buffer, fileName: string) => {
	const filePath = path.join(directory, fileName);
	writeFileSync(filePath, data);
	return Model.fromXlsx(filePath, "en", "UTC", "en");
};

const assertLiteralTexts = (
	workbook: Model,
	row: number,
	values: readonly [number, string][],
) => {
	for (const [column, value] of values) {
		assert.equal(workbook.getCellValue(0, row, column), value);
		assert.equal(workbook.getCellType(0, row, column), 2);
		assert.equal(workbook.getCellFormula(0, row, column), null);
	}
};

before(async () => {
	runningBot = await startBot({ model: SCRIPTED_MODEL });
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	rmSync(directory, { recursive: true, force: true });
});

test("office: XLSX, general subagent, DOCX and PPTX through code mode", {
	timeout: 5 * MINUTE,
}, async (t) => {
	await t.test(
		"edits an uploaded XLSX and delivers real typed cells and formulas",
		async () => {
			const source = new Model("Source", "en", "UTC", "en");
			source.renameSheet(0, "Data");
			source.updateCellWithText(0, 1, 1, runId);
			source.updateCellWithNumber(0, 2, 1, 10);
			source.updateCellWithNumber(0, 2, 2, 5);
			source.updateCellWithFormula(0, 2, 3, "=SUM(A2,B2)");
			source.updateCellWithText(0, 2, 4, "00123");
			source.updateCellWithText(0, 2, 5, "2026-10-08");
			source.updateCellWithText(0, 2, 6, "=literal");
			source.updateCellWithBool(0, 2, 7, true);
			source.updateCellWithText(0, 2, 8, "clear me");
			source.evaluate();
			const sourcePath = path.join(directory, xlsxSource);
			source.saveToXlsx(sourcePath);
			await upload(sourcePath);

			const fileName = `edited-${runId}.xlsx`;
			const completed = `XLSX-DONE-${runId}`;
			const attachment = await sendAndWaitForDocument(
				client,
				bot,
				{
					text: script(
						codemode(
							`${FIND_FILE}const source = await file(${quoted(xlsxSource)});
const { workbookId } = await tools.spreadsheet_open({ fileId: source.id });
await tools.spreadsheet_write({ workbookId, sheet: "Data", cells: [
	{ row: 2, column: 1, value: 20 },
	{ row: 2, column: 2, value: 7 },
	{ row: 2, column: 3, formula: "=SUM(A2,B2)" },
	{ row: 2, column: 4, value: "00123" },
	{ row: 2, column: 5, value: "2026-10-08" },
	{ row: 2, column: 6, value: "=literal" },
	{ row: 2, column: 7, value: false },
	{ row: 2, column: 8, value: null },
] });
await tools.spreadsheet_insert_rows({ workbookId, sheet: "Data", row: 2, count: 1 });
await tools.spreadsheet_rename_sheet({ workbookId, sheet: "Data", name: "Edited" });
await tools.spreadsheet_style({ workbookId, sheet: "Edited", row: 1, column: 1, endRow: 1, endColumn: 1,
	properties: { "font.name": "Arial", "font.sz": "14", "font.b": "true" } });
const exported = await tools.spreadsheet_export({ workbookId, fileName: ${quoted(fileName)} });
await tools.telegram_send_file({ fileId: exported.id });
await tools.spreadsheet_close({ workbookId });`,
						),
						say(completed),
					),
				},
				{
					fileName,
					matches: (text) => text.includes(completed),
					timeoutMs: MINUTE,
				},
			);
			assert.equal(attachment.fileName, fileName);
			assert.equal(attachment.mimeType, XLSX);
			const edited = readXlsx(attachment.data, fileName);
			assert.deepEqual(
				edited.getWorksheetsProperties().map(({ name }) => name),
				["Edited"],
			);
			assert.equal(edited.getCellValue(0, 1, 1), runId);
			const headingFont = edited.getCellStyle(0, 1, 1).font;
			assert.equal(headingFont?.name, "Arial");
			assert.equal(headingFont?.sz, 14);
			assert.equal(headingFont?.b, true);
			assert.equal(edited.getCellValue(0, 2, 1), null);
			assert.equal(edited.getCellValue(0, 3, 1), 20);
			assert.equal(edited.getCellValue(0, 3, 2), 7);
			assert.equal(edited.getCellFormula(0, 3, 3), "=SUM(A3,B3)");
			edited.evaluate();
			assert.equal(edited.getCellValue(0, 3, 3), 27);
			assertLiteralTexts(edited, 3, [
				[4, "00123"],
				[5, "2026-10-08"],
				[6, "=literal"],
			]);
			assert.equal(edited.getCellValue(0, 3, 7), false);
			assert.equal(edited.getCellValue(0, 3, 8), null);
		},
	);

	await t.test(
		"general edits an isolated source copy in the background and parent delivers it",
		async () => {
			const fileName = `general-${runId}.xlsx`;
			const started = `GENERAL-START-${runId}`;
			const completed = `GENERAL-DONE-${runId}`;
			// The subagent answers with the source's values from before its edit.
			const task = script(
				codemode(
					`${FIND_FILE}const source = await file(${quoted(xlsxSource)});
const { workbookId } = await tools.spreadsheet_open({ fileId: source.id });
const { cells } = await tools.spreadsheet_read({ workbookId, sheet: "Data", row: 2, column: 1, endRow: 2, endColumn: 2 });
await tools.spreadsheet_write({ workbookId, sheet: "Data", cells: [
	{ row: 2, column: 1, value: 40 },
	{ row: 2, column: 2, value: 2 },
	{ row: 2, column: 4, value: "00456" },
	{ row: 2, column: 5, value: "2027-01-02" },
	{ row: 2, column: 6, value: "=not a formula" },
	{ row: 2, column: 7, value: false },
	{ row: 2, column: 8, value: null },
] });
await tools.spreadsheet_export({ workbookId, fileName: ${quoted(fileName)} });
return "SOURCE=" + cells[0].value + "," + cells[1].value;`,
				),
				say("{{result}}"),
			);
			const attachment = await sendAndWaitForDocument(
				client,
				bot,
				{
					text: script(
						call("subagent", { agent: "general", tasks: [task] }),
						say(started),
						// Once the subagent has reported back.
						codemode(
							`${FIND_FILE}await tools.telegram_send_file({ fileId: (await file(${quoted(fileName)})).id });`,
						),
						say(`${completed} {{match:SOURCE=\\d+,\\d+}}`),
					),
				},
				{
					fileName,
					matches: (text) => text.includes(completed),
					timeoutMs: 2 * MINUTE,
				},
			);
			const startedAt = attachment.texts.findIndex((text) =>
				text.includes(started),
			);
			assert.ok(
				startedAt >= 0,
				`Missing background acknowledgement; received: ${attachment.texts.join(" | ")}`,
			);
			assert.ok(
				startedAt <
					attachment.texts.findIndex((text) => text.includes(completed)),
				"Background acknowledgement must precede completion",
			);
			assert.match(attachment.reply, /SOURCE=10,5/);
			assert.equal(attachment.mimeType, XLSX);
			const edited = readXlsx(attachment.data, fileName);
			assert.deepEqual(
				edited.getWorksheetsProperties().map(({ name }) => name),
				["Data"],
			);
			assert.equal(edited.getCellValue(0, 1, 1), runId);
			assert.equal(edited.getCellValue(0, 2, 1), 40);
			assert.equal(edited.getCellValue(0, 2, 2), 2);
			assert.equal(edited.getCellFormula(0, 2, 3), "=SUM(A2,B2)");
			edited.evaluate();
			assert.equal(edited.getCellValue(0, 2, 3), 42);
			assertLiteralTexts(edited, 2, [
				[4, "00456"],
				[5, "2027-01-02"],
				[6, "=not a formula"],
			]);
			assert.equal(edited.getCellValue(0, 2, 7), false);
			assert.equal(edited.getCellValue(0, 2, 8), null);
		},
	);

	await t.test(
		"edits an uploaded DOCX across formatted runs and a table cell, preserving the original",
		async () => {
			const sourceName = `word-source-${runId}.docx`;
			const sourcePath = path.join(directory, sourceName);
			const sourceBytes = await createWordFixture(runId);
			writeFileSync(sourcePath, sourceBytes);
			const source = await inspectWord(sourceBytes);
			assert.equal(source.paragraphs[0]?.text, "Before old phrase after.");
			assert.ok(
				source.paragraphs[0]?.runs.some(
					(run) => run.text === "old " && run.format.bold,
				),
			);
			assert.ok(
				source.paragraphs[0]?.runs.some(
					(run) => run.text === "phrase" && run.format.italic,
				),
			);
			await upload(sourcePath);

			const fileName = `word-edited-${runId}.docx`;
			const completed = `DOCX-DONE-${runId}`;
			const attachment = await sendAndWaitForDocument(
				client,
				bot,
				{
					text: script(
						codemode(
							`${FIND_FILE}const source = await file(${quoted(sourceName)});
const { documentId } = await tools.docx_open({ fileId: source.id });
await tools.docx_replace_text({ documentId, find: "old phrase", replacement: "new phrase" });
await tools.docx_write_table_cell({ documentId, table: 1, row: 2, column: 2, text: "Approved" });
const exported = await tools.docx_export({ documentId, fileName: ${quoted(fileName)} });
await tools.telegram_send_file({ fileId: exported.id });
await tools.telegram_send_file({ fileId: source.id });`,
						),
						say(completed),
					),
				},
				{
					fileName,
					additionalFileNames: [sourceName],
					matches: (text) => text.includes(completed),
					timeoutMs: MINUTE,
				},
			);
			assert.equal(attachment.fileName, fileName);
			assert.equal(
				attachment.mimeType,
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			);
			assert.equal(attachment.additionalDocuments[0]?.fileName, sourceName);
			assert.deepEqual(attachment.additionalDocuments[0]?.data, sourceBytes);
			const edited = await inspectWord(attachment.data);
			assert.equal(edited.paragraphs.length, source.paragraphs.length);
			assert.equal(edited.paragraphs[0]?.text, "Before new phrase after.");
			assert.deepEqual(edited.paragraphs.slice(1), source.paragraphs.slice(1));
			assert.deepEqual(
				edited.paragraphs[0]?.format,
				source.paragraphs[0]?.format,
			);
			const replacement = edited.paragraphs[0]?.runs.find((run) =>
				run.text.includes("new phrase"),
			);
			assert.ok(replacement, "Replacement must remain in a formatted run");
			assert.equal(replacement.format.bold, true);
			assert.equal(replacement.format.color, "AA0000");
			for (const text of ["Before ", " after."]) {
				assert.deepEqual(
					edited.paragraphs[0]?.runs.find((run) => run.text === text),
					source.paragraphs[0]?.runs.find((run) => run.text === text),
				);
			}
			assert.equal(source.tables[0]?.rows[1]?.[1]?.text, "Pending");
			const expectedTables = structuredClone(source.tables);
			const cell = expectedTables[0]?.rows[1]?.[1];
			assert.ok(cell);
			cell.text = "Approved";
			assert.deepEqual(edited.tables, expectedTables);
		},
	);

	await t.test(
		"edits an uploaded PPTX title while preserving other shapes, slides and the original",
		async () => {
			const sourceName = `slides-source-${runId}.pptx`;
			const sourcePath = path.join(directory, sourceName);
			const sourceBytes = await createPresentationFixture(runId);
			writeFileSync(sourcePath, sourceBytes);
			const source = await inspectPresentation(sourceBytes);
			assert.equal(source.slides.length, 2);
			await upload(sourcePath);

			const fileName = `slides-edited-${runId}.pptx`;
			const completed = `PPTX-DONE-${runId}`;
			const oldTitle = `Old title ${runId}`;
			const newTitle = `New title ${runId}`;
			const attachment = await sendAndWaitForDocument(
				client,
				bot,
				{
					text: script(
						codemode(
							`${FIND_FILE}const source = await file(${quoted(sourceName)});
const { presentationId, info } = await tools.pptx_open({ fileId: source.id });
const { slideId } = info.slides[0];
const { shapes } = await tools.pptx_read({ presentationId, slideId });
const title = shapes.find((shape) => shape.source === "slide" && shape.text === ${quoted(oldTitle)});
await tools.pptx_update_text({ presentationId, slideId, shapeId: title.shapeId, text: ${quoted(newTitle)} });
const exported = await tools.pptx_export({ presentationId, fileName: ${quoted(fileName)} });
await tools.telegram_send_file({ fileId: exported.id });
await tools.telegram_send_file({ fileId: source.id });`,
						),
						say(completed),
					),
				},
				{
					fileName,
					additionalFileNames: [sourceName],
					matches: (text) => text.includes(completed),
					timeoutMs: MINUTE,
				},
			);
			assert.equal(attachment.fileName, fileName);
			assert.equal(
				attachment.mimeType,
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			);
			assert.equal(attachment.additionalDocuments[0]?.fileName, sourceName);
			assert.deepEqual(attachment.additionalDocuments[0]?.data, sourceBytes);
			const edited = await inspectPresentation(attachment.data);
			const expected = structuredClone(source);
			const title = expected.slides[0]?.shapes.find(
				(shape) => shape.text === oldTitle,
			);
			assert.ok(title, "Fixture must have an editable first-slide title");
			title.text = newTitle;
			assert.deepEqual(edited, expected);
		},
	);
});
