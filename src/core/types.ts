export interface BuildConfiguration {
  readonly matrix: MatrixDefinition;
  readonly pipeline: PipelineDefinition;
}
export type Dimension = readonly DimensionValue[];
export type DimensionValue = boolean | number | string;

export type DimensionValues = Readonly<Record<string, DimensionValue>>;

export type FailurePolicy = 'continue' | 'fail-fast';

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = boolean | JsonObject | null | number | readonly JsonValue[] | string;
export interface MatrixDefinition {
  readonly dimensions: Readonly<Record<string, Dimension>>;
  readonly exclude?: readonly DimensionValues[];
  readonly idTemplate?: string;
  readonly include?: readonly DimensionValues[];
  readonly maxVariants?: number;
}
export interface PipelineDefinition {
  readonly resourceLimits?: ResourceLimits;
  readonly stages: readonly StageDefinition[];
}
export interface Plan {
  readonly resourceLimits?: ResourceLimits;
  readonly stages: readonly PlannedStage[];
  readonly variants: readonly Variant[];
}

export interface PlannedStage extends StageDefinition {
  readonly failurePolicy: FailurePolicy;
  readonly tasks: readonly PlannedTask[];
}

export interface PlannedTask extends TaskDefinition {
  readonly scope: TaskScope;
}

export type ResourceLimits = Readonly<Record<string, number>>;

export interface StageDefinition {
  readonly failurePolicy?: FailurePolicy;
  readonly id: string;
  readonly tasks: readonly TaskDefinition[];
}

export interface TaskCacheDefinition {
  readonly env?: readonly string[];
  readonly inputs: readonly string[];
  /** Paths fingerprinted for cache reuse and reported when the adapter omits its output list. */
  readonly outputs: readonly string[];
  /** Version fingerprint of the adapter and tools used by this task. */
  readonly version: string;
}

export interface TaskDefinition<Options extends JsonValue = JsonValue> {
  readonly adapter: string;
  readonly cache?: TaskCacheDefinition;
  readonly id: string;
  readonly options?: Options;
  readonly resourceGroup?: string;
  readonly scope?: TaskScope;
}

export type TaskScope = 'global' | 'variant';

export interface Variant {
  readonly id: string;
  readonly values: DimensionValues;
}
