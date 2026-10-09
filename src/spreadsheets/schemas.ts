import { Type } from "typebox";

export const MAX_ROWS = 1048576;
export const MAX_COLUMNS = 16384;
const string = () => Type.String({ minLength: 1, maxLength: 1024 });
const row = () => Type.Integer({ minimum: 1, maximum: MAX_ROWS });
const column = () => Type.Integer({ minimum: 1, maximum: MAX_COLUMNS });
const handle = { workbookId: string() };
const sheet = { ...handle, sheet: string() };
const range = {
	...sheet,
	row: row(),
	column: column(),
	endRow: row(),
	endColumn: column(),
};
const strict = { additionalProperties: false };
const booleanStyle = () =>
	Type.Union([Type.Literal("true"), Type.Literal("false")]);
const colorStyle = () => Type.String({ pattern: "^#[\\da-fA-F]{6}$" });
const styleProperties = Type.Object(
	{
		"font.b": Type.Optional(booleanStyle()),
		"font.i": Type.Optional(booleanStyle()),
		"font.u": Type.Optional(booleanStyle()),
		"font.strike": Type.Optional(booleanStyle()),
		"font.sz": Type.Optional(Type.String({ maxLength: 1024 })),
		"font.name": Type.Optional(Type.String({ maxLength: 1024 })),
		"font.color": Type.Optional(colorStyle()),
		"fill.color": Type.Optional(colorStyle()),
		num_fmt: Type.Optional(Type.String({ maxLength: 1024 })),
		"alignment.horizontal": Type.Optional(
			Type.Union(
				[
					"left",
					"center",
					"right",
					"general",
					"centerContinuous",
					"distributed",
					"fill",
					"justify",
				].map((value) => Type.Literal(value)),
			),
		),
		"alignment.vertical": Type.Optional(
			Type.Union(
				["bottom", "center", "distributed", "justify", "top"].map((value) =>
					Type.Literal(value),
				),
			),
		),
		"alignment.wrap_text": Type.Optional(booleanStyle()),
	},
	{ ...strict, minProperties: 1 },
);
const cell = Type.Union([
	Type.Object(
		{
			row: row(),
			column: column(),
			value: Type.Union([
				Type.String({ maxLength: 32767 }),
				Type.Number(),
				Type.Boolean(),
				Type.Null(),
			]),
		},
		strict,
	),
	Type.Object(
		{
			row: row(),
			column: column(),
			formula: Type.String({ pattern: "^=", maxLength: 32767 }),
		},
		strict,
	),
]);

export const spreadsheetSchemas = {
	create: Type.Object({ name: string() }, strict),
	open: Type.Object({ fileId: string() }, strict),
	info: Type.Object(handle, strict),
	read: Type.Object(range, strict),
	write: Type.Object(
		{ ...sheet, cells: Type.Array(cell, { minItems: 1, maxItems: 10000 }) },
		strict,
	),
	move_columns: Type.Object(
		{
			...sheet,
			column: column(),
			count: column(),
			delta: Type.Integer({ minimum: -MAX_COLUMNS, maximum: MAX_COLUMNS }),
		},
		strict,
	),
	insert_rows: Type.Object({ ...sheet, row: row(), count: row() }, strict),
	delete_rows: Type.Object({ ...sheet, row: row(), count: row() }, strict),
	insert_columns: Type.Object(
		{ ...sheet, column: column(), count: column() },
		strict,
	),
	delete_columns: Type.Object(
		{ ...sheet, column: column(), count: column() },
		strict,
	),
	add_sheet: Type.Object({ ...handle, name: string() }, strict),
	rename_sheet: Type.Object({ ...sheet, name: string() }, strict),
	style: Type.Object({ ...range, properties: styleProperties }, strict),
	recalculate: Type.Object(handle, strict),
	clone: Type.Object(handle, strict),
	export: Type.Object({ ...handle, fileName: string() }, strict),
	preview: Type.Object(handle, strict),
	close: Type.Object(handle, strict),
} as const;

export const rowOperations = ["insert_rows", "delete_rows"] as const;
export const columnOperations = ["insert_columns", "delete_columns"] as const;
