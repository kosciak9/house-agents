import { type Static, Type } from "typebox";

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
export const name = Type.String({ minLength: 1, maxLength: 200 });
export const id = Type.String({ minLength: 1, maxLength: 128 });
export const color = Type.String({ pattern: "^#?[0-9A-Fa-f]{6}$" });
const text = Type.String({ maxLength: 100_000 });
const index = Type.Integer({ minimum: 0, maximum: 10_000 });
const alignment = Type.Union([
	Type.Literal("left"),
	Type.Literal("center"),
	Type.Literal("right"),
]);
export const style = object({
	font: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
	size: Type.Optional(Type.Number({ minimum: 1, maximum: 400 })),
	color: Type.Optional(color),
	bold: Type.Optional(Type.Boolean()),
	italic: Type.Optional(Type.Boolean()),
	underline: Type.Optional(Type.Boolean()),
});
export type Style = Static<typeof style>;
const placement = {
	x: Type.Number({ minimum: -56, maximum: 56 }),
	y: Type.Number({ minimum: -56, maximum: 56 }),
	w: Type.Number({ exclusiveMinimum: 0, maximum: 56 }),
	h: Type.Number({ exclusiveMinimum: 0, maximum: 56 }),
};
const slide = { slideId: id };
const shape = { ...slide, shapeId: Type.Integer({ minimum: 1 }) };
const run = object({ text, style: Type.Optional(style) });
const paragraphs = Type.Array(
	object({
		runs: Type.Array(run, { minItems: 1, maxItems: 100 }),
		align: Type.Optional(alignment),
	}),
	{ minItems: 1, maxItems: 100 },
);
export const operations = {
	configure: object({
		width: Type.Optional(Type.Number({ minimum: 1, maximum: 56 })),
		height: Type.Optional(Type.Number({ minimum: 1, maximum: 56 })),
	}),
	info: object({
		offset: Type.Optional(index),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	}),
	read: object({
		...slide,
		offset: Type.Optional(index),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		includeInherited: Type.Optional(Type.Boolean()),
	}),
	add_slide: object({
		layoutId: Type.Optional(id),
		background: Type.Optional(color),
		atIndex: Type.Optional(index),
	}),
	remove_slide: object(slide),
	move_slide: object({ ...slide, toIndex: index }),
	duplicate_slide: object({ ...slide, atIndex: Type.Optional(index) }),
	add_text: object({
		...slide,
		...placement,
		name: Type.Optional(name),
		text: Type.Optional(text),
		paragraphs: Type.Optional(paragraphs),
		style: Type.Optional(style),
		align: Type.Optional(alignment),
	}),
	update_text: object({
		...shape,
		text,
		style: Type.Optional(style),
		selection: Type.Optional(
			Type.Union([
				object({
					kind: Type.Literal("run"),
					paragraphIndex: index,
					runIndex: index,
				}),
				object({
					kind: Type.Literal("range"),
					start: Type.Integer({ minimum: 0, maximum: 100_000 }),
					end: Type.Integer({ minimum: 0, maximum: 100_000 }),
				}),
			]),
		),
	}),
	replace_text: object({ ...shape, paragraphs }),
	add_shape: object({
		...slide,
		...placement,
		name: Type.Optional(name),
		preset: Type.Union(
			[
				"rect",
				"roundRect",
				"ellipse",
				"triangle",
				"diamond",
				"rightArrow",
				"leftArrow",
				"chevron",
				"hexagon",
				"star5",
				"line",
			].map((value) => Type.Literal(value)),
		),
		text: Type.Optional(text),
		fill: Type.Optional(color),
		stroke: Type.Optional(color),
		strokeWidth: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
		style: Type.Optional(style),
	}),
	add_image: object({
		...slide,
		...placement,
		name: Type.Optional(name),
		fileId: id,
		fit: Type.Optional(
			Type.Union([Type.Literal("contain"), Type.Literal("fill")]),
		),
	}),
	update_shape: object({
		...shape,
		x: Type.Optional(placement.x),
		y: Type.Optional(placement.y),
		w: Type.Optional(placement.w),
		h: Type.Optional(placement.h),
		fill: Type.Optional(color),
		stroke: Type.Optional(color),
		strokeWidth: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
		rotation: Type.Optional(Type.Number({ minimum: -360, maximum: 360 })),
	}),
	remove_shape: object(shape),
	notes: object({ ...slide, text: Type.Optional(text) }),
	export: object({}),
};
export type Operation = keyof typeof operations;
export type OperationArgs<K extends Operation> = Static<(typeof operations)[K]>;
