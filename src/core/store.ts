import { NmgStoreBase } from "./store/base.ts";
import { withGraph } from "./store/graph.ts";
import { withRetrieval } from "./store/retrieval.ts";
import { withWrites } from "./store/writes.ts";
import { withMaintenance } from "./store/maintenance.ts";
import { withAnalogy } from "./store/analogy.ts";

export class NmgStore extends withGraph(
  withAnalogy(withRetrieval(withWrites(withMaintenance(NmgStoreBase)))),
) {}
