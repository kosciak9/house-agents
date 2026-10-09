import type { CodemodeTool } from "@earendil-works/pi-codemode";
import type { Static } from "typebox";
import { localTool } from "../../codemode/local-tool.ts";
import { exportFile, previewCopy, sourceFile } from "../files.ts";
import {
	callWorkingCopy,
	closeWorkingCopy,
	createWorkingCopy,
} from "../working-copy.ts";
import {
	columnOperations,
	MAX_COLUMNS,
	MAX_ROWS,
	rowOperations,
	schemas,
} from "./schemas.ts";

const createWorkbook = async (
	name: string,
	bytes: Buffer | undefined,
	signal: AbortSignal,
) => {
	const { id, info } = await createWorkingCopy("xlsx", { name, bytes }, signal);
	return { workbookId: id, info };
};
type WorkbookOperation = Exclude<keyof typeof schemas, "create" | "open">;
const dispatch = (
	operation: WorkbookOperation,
	args: Static<(typeof schemas)[WorkbookOperation]>,
	signal: AbortSignal,
) => callWorkingCopy("xlsx", args.workbookId, operation, args, signal);

const validateRange = ({
	row,
	column,
	endRow,
	endColumn,
}: Static<typeof schemas.read>) => {
	if (
		endRow < row ||
		endColumn < column ||
		(endRow - row + 1) * (endColumn - column + 1) > 10000
	)
		throw new Error("Range must be ordered and contain at most 10,000 cells.");
};
const validateExtent = (start: number, count: number, maximum: number) => {
	if (start + count - 1 > maximum)
		throw new Error("Requested rows/columns exceed worksheet limits.");
};
const validateSheetName = (name: string) => {
	if (name.length > 31 || /[\\/*?:[\]]/.test(name))
		throw new Error(
			"Sheet name must be at most 31 characters and contain no Excel forbidden characters.",
		);
};
const validateWrite = ({ cells }: Static<typeof schemas.write>) => {
	let bytes = 0;
	for (const cell of cells) {
		if (
			"value" in cell &&
			typeof cell.value === "number" &&
			!Number.isFinite(cell.value)
		)
			throw new Error("Cell numbers must be finite.");
		bytes += Buffer.byteLength(JSON.stringify(cell));
		if (bytes > 2 * 1024 * 1024)
			throw new Error(
				"Write batch exceeds 2 MiB. Split it into smaller awaited batches.",
			);
	}
};
export const xlsxTools: readonly CodemodeTool[] = [
	localTool(
		"spreadsheet_create",
		"Create an isolated editable RAM workbook; returns {workbookId, info}. Handles survive codemode scripts, not restart; close when finished. English formula/input locale, UTC. Simple data spreadsheets only: unsupported Excel features may be lost.",
		schemas.create,
		async (args, { signal }) => createWorkbook(args.name, undefined, signal),
	),
	localTool(
		"spreadsheet_open",
		"Open an XLSX RAM file as an isolated editable copy; returns {workbookId, info}, source bytes stay immutable. Unsupported Excel features may be lost on export. Locale/formulas English, UTC; text dates are not interpreted.",
		schemas.open,
		async (args, { signal }) => {
			const file = sourceFile("xlsx", args.fileId);
			return createWorkbook(file.fileName, file.data, signal);
		},
	),
	localTool(
		"spreadsheet_info",
		"Workbook name and sheet names, visibility and used bounds [minRow,maxRow,minColumn,maxColumn].",
		schemas.info,
		async (args, { signal }) => dispatch("info", args, signal),
	),
	localTool(
		"spreadsheet_read",
		"Read at most 10,000 cells; returns native typed values, formulas, formatted text and error type (16). Coordinates are 1-based and sheet is its exact name.",
		schemas.read,
		async (args, { signal }) => {
			validateRange(args);
			return dispatch("read", args, signal);
		},
	),
	localTool(
		"spreadsheet_write",
		"Write typed cells without guessing strings/dates: strings stay literal (even =text); numbers/booleans preserved, null clears. Use separate formula field with =, English names/comma arguments. Entire batch is validated first but engine errors may leave partial edits. Recalculates once after batch.",
		schemas.write,
		async (args, { signal }) => {
			validateWrite(args);
			return dispatch("write", args, signal);
		},
	),
	localTool(
		"spreadsheet_move_columns",
		"Move count whole columns starting at column by signed delta; uses native dependency/formula-aware moveColumns, not cell copying.",
		schemas.move_columns,
		async (args, { signal }) => {
			validateExtent(args.column, args.count, MAX_COLUMNS);
			if (
				args.column + args.delta < 1 ||
				args.column + args.delta + args.count - 1 > MAX_COLUMNS
			)
				throw new Error("Moved columns exceed worksheet limits.");
			return dispatch("move_columns", args, signal);
		},
	),
	...rowOperations.map((operation) =>
		localTool(
			`spreadsheet_${operation}`,
			`${operation.replaceAll("_", " ")} with native formula/dependency updates. Indices/count are 1-based.`,
			schemas[operation],
			async (args, { signal }) => {
				validateExtent(args.row, args.count, MAX_ROWS);
				return dispatch(operation, args, signal);
			},
		),
	),
	...columnOperations.map((operation) =>
		localTool(
			`spreadsheet_${operation}`,
			`${operation.replaceAll("_", " ")} with native formula/dependency updates. Indices/count are 1-based.`,
			schemas[operation],
			async (args, { signal }) => {
				validateExtent(args.column, args.count, MAX_COLUMNS);
				return dispatch(operation, args, signal);
			},
		),
	),
	localTool(
		"spreadsheet_add_sheet",
		"Add a named empty worksheet.",
		schemas.add_sheet,
		async (args, { signal }) => {
			validateSheetName(args.name);
			return dispatch("add_sheet", args, signal);
		},
	),
	localTool(
		"spreadsheet_rename_sheet",
		"Rename sheet using native formula reference updates.",
		schemas.rename_sheet,
		async (args, { signal }) => {
			validateSheetName(args.name);
			return dispatch("rename_sheet", args, signal);
		},
	),
	localTool(
		"spreadsheet_style",
		"Apply native range style properties: font.b/i/u/strike (strings true/false), font.sz/name/color, fill.color, num_fmt, alignment.horizontal/vertical/wrap_text. Colors #RRGGBB. Max 10,000 cells.",
		schemas.style,
		async (args, { signal }) => {
			validateRange(args);
			const size = args.properties["font.sz"];
			if (
				"font.sz" in args.properties &&
				(!Number.isFinite(Number(size)) ||
					Number(size) < 1 ||
					Number(size) > 409)
			)
				throw new Error(
					"font.sz must be a number from 1 to 409, encoded as a string.",
				);
			return dispatch("style", args, signal);
		},
	),
	localTool(
		"spreadsheet_recalculate",
		"Evaluate workbook using IronCalc (not LibreOffice).",
		schemas.recalculate,
		async (args, { signal }) => dispatch("recalculate", args, signal),
	),
	localTool(
		"spreadsheet_clone",
		"Create an explicitly isolated copy of an existing workbook, preserving current unsaved edits; returns {workbookId, info}.",
		schemas.clone,
		async (args, { signal }) => {
			const bytes = await callWorkingCopy(
				"xlsx",
				args.workbookId,
				"clone",
				{},
				signal,
			);
			const cloned = await createWorkbook("Clone", undefined, signal);
			try {
				return {
					workbookId: cloned.workbookId,
					info: await callWorkingCopy(
						"xlsx",
						cloned.workbookId,
						"load_clone",
						{ bytes },
						signal,
					),
				};
			} catch (error) {
				await closeWorkingCopy("xlsx", cloned.workbookId);
				throw error;
			}
		},
	),
	localTool(
		"spreadsheet_export",
		"Export current edits as real XLSX bytes in RAM; returns {id, fileName, mimeType, size}. Pass this id as fileId to file_read for base64 attachment bridge or Telegram delivery. Simple data spreadsheets only; source unchanged.",
		schemas.export,
		async (args, { signal }) =>
			exportFile("xlsx", args.workbookId, args.fileName, signal),
	),
	localTool(
		"spreadsheet_preview",
		"Render an exported copy via existing Gotenberg/LibreOffice → PDF. Returns JPEG image blocks (return the result or use image(block)); at most first 10 pages. LibreOffice may recalculate differently; preview is not proof of IronCalc values. Does not edit workbook cells or source.",
		schemas.preview,
		async (args, { signal }) => {
			const preview = await previewCopy("xlsx", args.workbookId, signal);
			return {
				...preview,
				provenance:
					"LibreOffice-rendered exported copy; may recalculate differently from IronCalc. Workbook unchanged.",
			};
		},
	),
	localTool(
		"spreadsheet_close",
		"Close a RAM workbook and discard unsaved edits. Exported files and source remain available separately.",
		schemas.close,
		async (args) => closeWorkingCopy("xlsx", args.workbookId),
	),
];
