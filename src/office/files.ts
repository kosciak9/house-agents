import { config } from "../config.ts";
import { convertToPdf } from "../documents/gotenberg.ts";
import { renderPages } from "../documents/pdf.ts";
import { type FileMetadata, getFile, putFile } from "../files/store.ts";
import { type OfficeFormat, officeFormat, officeFormats } from "./formats.ts";
import { callWorkingCopy } from "./working-copy.ts";

// Working copies open from the RAM file store and export back to it as new
// files; the source file never changes.

/** The stored file `fileId`, which must be a `format` file. */
export const sourceFile = (format: OfficeFormat, fileId: string) => {
	const file = getFile(fileId);
	if (officeFormat(file) !== format)
		throw new Error(`Expected a .${format} file.`);
	return file;
};

/** `name` as a file name of `format`, its extension added if missing. */
export const fileName = (format: OfficeFormat, name: string): string => {
	if (
		/[\\/]/.test(name) ||
		[...name].some((character) => character.charCodeAt(0) < 32)
	)
		throw new Error("Use a file name, not a path.");
	return name.toLowerCase().endsWith(`.${format}`) ? name : `${name}.${format}`;
};

const isZip = (bytes: Buffer): boolean =>
	bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;

/** The working copy's current edits as the bytes of a `format` file. */
export const exportBytes = async (
	format: OfficeFormat,
	id: string,
	signal: AbortSignal,
): Promise<Buffer> => {
	const bytes = await callWorkingCopy(format, id, "export", {}, signal);
	if (!(bytes instanceof Uint8Array) || !isZip(Buffer.from(bytes)))
		throw new Error(`The ${format} export is not a ZIP package.`);
	signal.throwIfAborted();
	return Buffer.from(bytes);
};

/** Stores the working copy's export as a new file. */
export const exportFile = async (
	format: OfficeFormat,
	id: string,
	name: string,
	signal: AbortSignal,
): Promise<FileMetadata> =>
	putFile({
		data: await exportBytes(format, id, signal),
		fileName: fileName(format, name),
		mimeType: officeFormats[format].mimeType,
	});

/** The working copy's export rendered through Gotenberg, as page images. */
export const previewCopy = async (
	format: OfficeFormat,
	id: string,
	signal: AbortSignal,
) => {
	const gotenbergUrl = config().gotenbergUrl;
	if (!gotenbergUrl)
		throw new Error(
			"File preview requires config.gotenbergUrl. Configure a reachable Gotenberg service to render previews.",
		);
	const { pdf, engine } = await convertToPdf(
		gotenbergUrl,
		{
			data: await exportBytes(format, id, signal),
			fileName: `preview.${format}`,
			mimeType: officeFormats[format].mimeType,
		},
		signal,
	);
	const pages = await renderPages(pdf, signal);
	signal.throwIfAborted();
	return {
		provenance: `${engine}-rendered exported copy. Source and working copy unchanged.`,
		pageCount: pages.pageCount,
		shownPages: pages.images.length,
		images: pages.images,
	};
};
