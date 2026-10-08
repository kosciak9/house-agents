import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import { config } from "../config.ts";
import { convertsWithChromium, convertToPdf } from "./gotenberg.ts";
import { renderPages } from "./pdf.ts";

// A file the user sends becomes what the model reads, before it reaches the
// agent: images as they are, PDF pages as images, text as text. Anything else
// is converted to PDF first when the deployment has Gotenberg, and the model
// is told it sees a conversion.

const MAX_TEXT_CHARS = 100_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// The image formats models read.
const MODEL_IMAGE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);
const TEXT_TYPES = new Set([
	"application/json",
	"application/xml",
	"application/x-yaml",
	"application/yaml",
	"application/csv",
]);

export type Document = {
	data: Buffer;
	fileName: string;
	mimeType: string;
};

type Content = (TextContent | ImageContent)[];

const text = (value: string): TextContent => ({ type: "text", text: value });

const pageImages = async (pdf: Buffer, label: string): Promise<Content> => {
	const { images, pageCount } = await renderPages(pdf);
	return [
		text(`${label}, pages 1–${images.length} of ${pageCount}, as images:`),
		...images.map(
			(image): ImageContent => ({
				type: "image",
				data: image.toString("base64"),
				mimeType: "image/jpeg",
			}),
		),
	];
};

const isText = (mimeType: string): boolean =>
	mimeType.startsWith("text/") || TEXT_TYPES.has(mimeType);

/** What the model gets of a file: what it is, then its content. */
export const readDocument = async (document: Document): Promise<Content> => {
	const { data, fileName, mimeType } = document;
	const about = `The user sent the file "${fileName}" (${mimeType}).`;
	const gotenbergUrl = config().gotenbergUrl;

	if (mimeType === "application/pdf") {
		try {
			return [text(about), ...(await pageImages(data, "The PDF"))];
		} catch (error) {
			console.error(`Rendering ${fileName} failed:`, error);
			return [text(`${about} Its content cannot be shown: it is not a PDF.`)];
		}
	}
	if (MODEL_IMAGE_TYPES.has(mimeType)) {
		if (data.length > MAX_IMAGE_BYTES) {
			return [text(`${about} The image is too large to show.`)];
		}
		return [
			text(about),
			{ type: "image", data: data.toString("base64"), mimeType },
		];
	}
	if (isText(mimeType) && !(gotenbergUrl && convertsWithChromium(mimeType))) {
		const content = data.toString("utf8");
		return [
			text(about),
			text(
				content.length > MAX_TEXT_CHARS
					? `${content.slice(0, MAX_TEXT_CHARS)}\n[… cut at ${MAX_TEXT_CHARS} of ${content.length} characters]`
					: content,
			),
		];
	}
	if (!gotenbergUrl) {
		return [text(`${about} Its content cannot be shown.`)];
	}

	try {
		const { pdf, engine } = await convertToPdf(gotenbergUrl, document);
		return [
			text(about),
			...(await pageImages(
				pdf,
				`Not the original file: it was converted to PDF with Gotenberg (${engine}), so it may look different from the original and anything that could not be rendered is missing. The PDF`,
			)),
		];
	} catch (error) {
		console.error(`Converting ${fileName} to PDF failed:`, error);
		return [
			text(
				`${about} Its content cannot be shown: converting it to PDF with Gotenberg failed.`,
			),
		];
	}
};
