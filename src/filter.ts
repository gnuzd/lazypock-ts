// ── Typed filter builder ────────────────────────────────
// A fluent, field-checked builder for PocketBase filter expressions.
//
//   const q = posts.where;
//   const expr = q("title").contains("x").and(q("published").eq(true));
//   // → (title ~ '%x%' && published = true)
//   await posts.getList(1, 20, { filter: expr });
//
// Field names and operators are checked at compile time (and suggested by
// the editor); values are escaped/quoted by the builder — no manual
// interpolation. The builder is intentionally not parameterised by the
// record shape for value types: that would make CollectionService
// invariant and break the typed-client assignability. Values are validated
// as filter scalars; the server enforces the per-field type.

/** A value that can appear on the right-hand side of a filter clause. */
export type FilterScalar = string | number | boolean | null;

/** Render a filter literal: quoted+escaped strings, raw numbers/booleans/null. */
function literal(value: FilterScalar): string {
	if (value === null) return "null";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(
				`[lazypock] filter: ${String(value)} is not a valid numeric value`,
			);
		}
		return String(value);
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	// Escape backslashes first, then single quotes (PocketBase string syntax).
	const escaped = String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
	return `'${escaped}'`;
}

/**
 * A built filter expression. Opaque to callers — pass it straight to the
 * `filter` option; the client serializes it via {@link FilterExpr.toString}.
 */
export class FilterExpr {
	/** The raw PocketBase filter string. */
	readonly raw: string;

	/** @internal Build from a raw string — use {@link FilterBuilder} instead. */
	constructor(raw: string) {
		this.raw = raw;
	}

	/** Combine with `&&` (both must match). */
	and(other: FilterExpr): FilterExpr {
		return new FilterExpr(`(${this.raw} && ${other.raw})`);
	}

	/** Combine with `||` (either may match). */
	or(other: FilterExpr): FilterExpr {
		return new FilterExpr(`(${this.raw} || ${other.raw})`);
	}

	/** Negate the expression (`!(…)`). */
	not(): FilterExpr {
		return new FilterExpr(`!(${this.raw})`);
	}

	/** The raw filter string (used when serializing the request). */
	toString(): string {
		return this.raw;
	}
}

/**
 * A single field clause, created via {@link CollectionService.where}.
 * Comparison methods return an immutable {@link FilterExpr}; chain
 * `.and()` / `.or()` / `.not()` to compose.
 *
 * The `any*` methods map to PocketBase's `?`-prefixed operators
 * ("at least one element of an array field matches") for multi-select /
 * multi-relation / multi-file fields.
 *
 * @typeParam F — The field being compared (validated against the collection).
 */
export class FilterBuilder<F extends string> {
	/** @internal */
	private readonly field: F;

	/** @internal Use {@link CollectionService.where}. */
	constructor(field: F) {
		this.field = field;
	}

	/** `field = value` (equal). */
	eq(value: FilterScalar): FilterExpr {
		return this.cmp("=", value);
	}
	/** `field != value` (not equal). */
	neq(value: FilterScalar): FilterExpr {
		return this.cmp("!=", value);
	}
	/** `field ~ value` (contains / LIKE). */
	contains(value: string): FilterExpr {
		return this.cmp("~", value);
	}
	/** `field !~ value` (does not contain / NOT LIKE). */
	notContains(value: string): FilterExpr {
		return this.cmp("!~", value);
	}
	/** `field > value` (greater than). */
	gt(value: FilterScalar): FilterExpr {
		return this.cmp(">", value);
	}
	/** `field >= value` (greater than or equal). */
	gte(value: FilterScalar): FilterExpr {
		return this.cmp(">=", value);
	}
	/** `field < value` (less than). */
	lt(value: FilterScalar): FilterExpr {
		return this.cmp("<", value);
	}
	/** `field <= value` (less than or equal). */
	lte(value: FilterScalar): FilterExpr {
		return this.cmp("<=", value);
	}

	/** `field ?= value` — at least one array element equals `value`. */
	anyEq(value: FilterScalar): FilterExpr {
		return this.cmp("?=", value);
	}
	/** `field ?!= value` — at least one array element differs. */
	anyNeq(value: FilterScalar): FilterExpr {
		return this.cmp("?!=", value);
	}
	/** `field ?~ value` — at least one array element contains `value`. */
	anyContains(value: string): FilterExpr {
		return this.cmp("?~", value);
	}
	/** `field ?!~ value` — at least one array element does not contain `value`. */
	anyNotContains(value: string): FilterExpr {
		return this.cmp("?!~", value);
	}
	/** `field ?> value` — at least one array element is greater. */
	anyGt(value: FilterScalar): FilterExpr {
		return this.cmp("?>", value);
	}
	/** `field ?>= value` — at least one array element is greater or equal. */
	anyGte(value: FilterScalar): FilterExpr {
		return this.cmp("?>=", value);
	}
	/** `field ?< value` — at least one array element is less. */
	anyLt(value: FilterScalar): FilterExpr {
		return this.cmp("?<", value);
	}
	/** `field ?<= value` — at least one array element is less or equal. */
	anyLte(value: FilterScalar): FilterExpr {
		return this.cmp("?<=", value);
	}

private cmp(op: string, value: FilterScalar): FilterExpr {
		return new FilterExpr(`${this.field} ${op} ${literal(value)}`);
	}
}
