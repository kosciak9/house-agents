import type { CodemodeTool } from "@earendil-works/pi-codemode";

import { docxTools } from "./docx/tools.ts";
import { pptxTools } from "./pptx/tools.ts";
import { xlsxTools } from "./xlsx/tools.ts";

/** Editing Office files in working copies, one set of tools per format. */
export const officeTools: readonly CodemodeTool[] = [
	...xlsxTools,
	...docxTools,
	...pptxTools,
];
