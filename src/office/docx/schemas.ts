import { type Static, type TSchema, Type } from "typebox";

const index = Type.Integer({ minimum: 1 });
const text = Type.String({ maxLength: 1_000_000 });
const runFormat = Type.Object(
	{
		bold: Type.Optional(Type.Boolean()),
		italic: Type.Optional(Type.Boolean()),
		underline: Type.Optional(Type.Boolean()),
		strike: Type.Optional(Type.Boolean()),
		font: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		size: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
		color: Type.Optional(Type.String({ pattern: "^[0-9A-Fa-f]{6}$" })),
	},
	{ additionalProperties: false },
);
const paragraphFormat = Type.Object(
	{
		heading: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
		alignment: Type.Optional(
			Type.Union([
				Type.Literal("left"),
				Type.Literal("center"),
				Type.Literal("right"),
				Type.Literal("both"),
			]),
		),
	},
	{ additionalProperties: false },
);
const paragraphInput = {
	text: Type.Optional(text),
	runs: Type.Optional(
		Type.Array(
			Type.Object(
				{ text, format: Type.Optional(runFormat) },
				{ additionalProperties: false },
			),
			{ maxItems: 10_000 },
		),
	),
	format: Type.Optional(paragraphFormat),
};
const paragraph = Type.Object(paragraphInput);
export type ParagraphInput = Static<typeof paragraph>;
const object = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
export const operations = {
	info: object({}),
	read: object({
		start: Type.Optional(index),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
		textOffset: Type.Optional(Type.Integer({ minimum: 0 })),
		textLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
	}),
	replace_text: object({
		find: Type.String({ minLength: 1, maxLength: 100_000 }),
		replacement: text,
		paragraph: Type.Optional(index),
		includeTables: Type.Optional(Type.Boolean()),
	}),
	insert_paragraph: object({ before: Type.Optional(index), ...paragraphInput }),
	delete_paragraph: object({ paragraph: index }),
	update_paragraph: object({ paragraph: index, ...paragraphInput }),
	add_table: object({
		rows: Type.Array(Type.Array(text, { minItems: 1, maxItems: 200 }), {
			minItems: 1,
			maxItems: 1000,
		}),
		before: Type.Optional(index),
	}),
	read_table: object({
		table: index,
		startRow: Type.Optional(index),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
		startColumn: Type.Optional(index),
		columnLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		textOffset: Type.Optional(Type.Integer({ minimum: 0 })),
		textLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
	}),
	write_table_cell: object({
		table: index,
		row: index,
		column: index,
		...paragraphInput,
	}),
	export: object({}),
};
export type Operation = keyof typeof operations;
