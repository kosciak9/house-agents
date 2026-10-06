import { createRegistry } from "@earendil-works/pi-durable";

import { createProgressExtension } from "../progress/extension.ts";
import { SchedulerExtension } from "../scheduler/extension.ts";
import { publishProgress } from "../telegram/progress.ts";

export const registry = createRegistry();
registry.install(SchedulerExtension);
registry.install(createProgressExtension(publishProgress));
