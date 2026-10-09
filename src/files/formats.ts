/** Editable Office packages; legacy and encrypted formats are not supported. */
export const officeFormats = {
	xlsx: {
		mimeType:
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		tools: "spreadsheet_*",
	},
	docx: {
		mimeType:
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		tools: "docx_*",
	},
	pptx: {
		mimeType:
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		tools: "pptx_*",
	},
} as const;

export type OfficeFormat = keyof typeof officeFormats;

export const officeFormat = (file: { fileName: string; mimeType: string }) =>
	(Object.keys(officeFormats) as OfficeFormat[]).find(
		(format) =>
			file.fileName.toLowerCase().endsWith(`.${format}`) ||
			file.mimeType === officeFormats[format].mimeType,
	);
