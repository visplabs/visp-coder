import { ok, type Result } from "../core/result.js";
import { type Activity, readSession } from "../orchestrate/session.js";
import { briefPath, productStatePath, readProductRecord } from "../workflow/product/store.js";
import { productSourceDigest } from "../workflow/product/subject.js";
import type { WorkspaceState } from "../workflow/state.js";
import {
  type ProductCapabilityFact,
  type ProductCapabilitySummary,
  summarizeProduct,
} from "./capabilities/product.js";

export interface CapabilityUtilization {
  readonly product: ProductCapabilitySummary;
  /** Features still in the pre-product layout; they are not summarized until migrated. */
  readonly unmigratedFeatures: number;
  /** Graph work recorded in the session, whoever asked for it. */
  readonly graph: {
    readonly indexBuilds: number;
    readonly indexRefreshes: number;
    readonly queries: number;
  };
}

export async function capabilityUtilization(
  state: WorkspaceState,
): Promise<Result<CapabilityUtilization>> {
  const session = await readSession(state);
  if (!session.ok) return session;
  const features = await state.store.listFeatures();
  if (!features.ok) return features;

  const products: ProductCapabilityFact[] = [];
  let unmigratedFeatures = 0;
  for (const feature of features.value) {
    const product = await productFact(state, feature);
    if (!product.ok) return product;
    if (product.value) products.push(product.value);
    else unmigratedFeatures++;
  }

  return ok({
    product: summarizeProduct(products),
    unmigratedFeatures,
    graph: summarizeGraph(session.value.activity),
  });
}

async function productFact(
  state: WorkspaceState,
  feature: string,
): Promise<Result<ProductCapabilityFact | undefined>> {
  const brief = await state.files.exists(briefPath(state, feature));
  if (!brief.ok) return brief;
  const productState = await state.files.exists(productStatePath(state, feature));
  if (!productState.ok) return productState;
  if (!brief.value && !productState.value) return ok(undefined);

  const record = await readProductRecord(state, { feature });
  if (!record.ok) return record;
  const subject =
    record.value.state.status === "historical-complete"
      ? ok(undefined)
      : await productSourceDigest(state, record.value.brief);
  if (!subject.ok) return subject;
  return ok({ record: record.value, subject: subject.value });
}

function summarizeGraph(activities: readonly Activity[]): CapabilityUtilization["graph"] {
  const count = (command: string) =>
    activities.filter((activity) => activity.command === command).length;
  return {
    indexBuilds: count("index"),
    indexRefreshes: count("index --refresh"),
    queries: count("query"),
  };
}
