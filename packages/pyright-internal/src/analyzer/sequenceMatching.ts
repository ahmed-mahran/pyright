/*
 * sequenceMatching.ts
 * Licensed under the MIT license.
 * Author: Ahmed Mahran
 *
 * Provides generic logic for matching two sequences and associating corresponding elements.
 */

export interface SequenceItem<Item> {
    item: Item;
    minMatches: number;
    maxMatches?: number;
}

export namespace SequenceItem {
    export function isRepeated<T>(item: SequenceItem<T>) {
        return item.maxMatches === undefined || item.maxMatches > 1 || (item.maxMatches === 1 && item.minMatches === 0);
    }
}

export class SequenceItemMatchTracker<Item> {
    sequenceItem: SequenceItem<Item>;
    matchesCounter: number = 0;

    constructor(sequenceItem: SequenceItem<Item>, matchesCounter: number = 0) {
        this.sequenceItem = sequenceItem;
        this.matchesCounter = matchesCounter;
    }

    hasMoreMatches(): boolean {
        return !this.sequenceItem.maxMatches || this.matchesCounter < this.sequenceItem.maxMatches;
    }

    matched(): SequenceItemMatchTracker<Item> {
        return new SequenceItemMatchTracker(this.sequenceItem, this.matchesCounter + 1);
    }

    isSkippable(): boolean {
        return this.sequenceItem.minMatches <= 0;
    }
}

function getItemToStringFunction<T>(toStr: (t: T | undefined) => string) {
    return function (t: SequenceItem<T> | undefined) {
        const tStr = toStr(t?.item);
        if (t === undefined) {
            return tStr;
        }
        const minMatches = t.minMatches;
        const maxMatches = t.maxMatches;
        if (minMatches === 1 && maxMatches === 1) {
            return tStr;
        }
        if (minMatches === 0 && maxMatches === undefined) {
            return `${tStr}*`;
        }
        if (minMatches === 1 && maxMatches === undefined) {
            return `${tStr}+`;
        }
        if (minMatches === 0 && maxMatches === 1) {
            return `${tStr}?`;
        }
        return `${tStr}{${minMatches}:${maxMatches ?? ''}}`;
    };
}

function getItemTrackerToStringFunction<T>(toStr: (t: T | undefined) => string) {
    const item_toStr = getItemToStringFunction(toStr);
    return function (t: SequenceItemMatchTracker<T> | undefined) {
        const tStr = item_toStr(t?.sequenceItem);
        if (t === undefined) {
            return tStr;
        }
        const maxMatches = t.sequenceItem.maxMatches;
        const matchedStr = maxMatches !== undefined && maxMatches <= 1 ? '' : `.[${t.matchesCounter}]`;
        return `${tStr}${matchedStr}`;
    };
}

export interface SequenceAccumulator<DestType, SrcType, Acc> {
    get value(): Acc;

    // Returns false if DestType and SrcType are not reducable.
    matches(
        dest: SequenceItemMatchTracker<DestType> | undefined,
        src: SequenceItemMatchTracker<SrcType> | undefined
    ): boolean;

    // Reduces DestType and SrcType and accumulates result into Acc.
    // Returns a copy of this with new accumulation.
    accumulate(
        dest: SequenceItemMatchTracker<DestType> | undefined,
        src: SequenceItemMatchTracker<SrcType> | undefined
    ): this;

    copy(): this;

    toString(): string;
}

export function matchSequence<DestType, SrcType>(
    destSequence: SequenceItem<DestType>[],
    srcSequence: SequenceItem<SrcType>[],
    destMatchesSrc: (dest: DestType, src: SrcType) => boolean,
    destStr: (dest: DestType | undefined) => string,
    srcStr: (src: SrcType | undefined) => string,
    recursionCount: number
): boolean {
    class MatchSequenceAccumulator implements SequenceAccumulator<DestType, SrcType, boolean> {
        acc: boolean;

        constructor() {
            this.acc = false;
        }

        get value(): boolean {
            return this.acc;
        }

        matches(
            destItem: SequenceItemMatchTracker<DestType> | undefined,
            srcItem: SequenceItemMatchTracker<SrcType> | undefined
        ): boolean {
            return (
                (destItem === undefined && srcItem === undefined) ||
                (destItem !== undefined &&
                    srcItem !== undefined &&
                    destItem.hasMoreMatches() &&
                    srcItem.hasMoreMatches() &&
                    destMatchesSrc(destItem.sequenceItem.item, srcItem.sequenceItem.item)) ||
                // destType matches zero src
                (destItem === undefined && srcItem !== undefined && srcItem.isSkippable()) ||
                // srcType matches zero dest
                (destItem !== undefined && destItem.isSkippable() && srcItem === undefined)
            );
        }

        accumulate(
            dest: SequenceItemMatchTracker<DestType> | undefined,
            src: SequenceItemMatchTracker<SrcType> | undefined
        ): this {
            const copy = this.copy();
            if (this.matches(dest, src)) {
                copy.acc = true;
            }
            return copy;
        }

        copy(): this {
            const cp = new MatchSequenceAccumulator();
            cp.acc = this.acc;
            return cp as this;
        }

        toString(): string {
            return `${this.acc}`;
        }
    }

    const acc = traverseAccumulateSequence(
        destSequence.map((destItem) => new SequenceItemMatchTracker(destItem)),
        srcSequence.map((srcItem) => new SequenceItemMatchTracker(srcItem)),
        new MatchSequenceAccumulator(),
        destStr,
        srcStr,
        recursionCount
    );

    return acc?.value === true;
}

export interface DestItemMatches<DestType, SrcType> {
    destItem: SequenceItem<DestType>;
    matchedSrcItems: SequenceItem<SrcType>[];
}

export function matchAccumulateSequence<DestType, SrcType>(
    destSequence: SequenceItem<DestType>[],
    srcSequence: SequenceItem<SrcType>[],
    destMatchesSrc: (dest: DestType, src: SrcType) => boolean,
    destStr: (dest: DestType | undefined) => string,
    srcStr: (src: SrcType | undefined) => string,
    recursionCount: number
): DestItemMatches<DestType, SrcType>[] | undefined {
    const destItemStr = getItemToStringFunction(destStr);
    const srcItemStr = getItemToStringFunction(srcStr);

    class MatchAccumulateSequenceAccumulator
        implements SequenceAccumulator<DestType, SrcType, DestItemMatches<DestType, SrcType>[]>
    {
        acc: DestItemMatches<DestType, SrcType>[];

        constructor() {
            this.acc = [];
        }

        get value(): DestItemMatches<DestType, SrcType>[] {
            return this.acc;
        }

        matches(
            destItem: SequenceItemMatchTracker<DestType> | undefined,
            srcItem: SequenceItemMatchTracker<SrcType> | undefined
        ): boolean {
            return (
                (destItem === undefined && srcItem === undefined) ||
                (destItem !== undefined &&
                    srcItem !== undefined &&
                    destItem.hasMoreMatches() &&
                    srcItem.hasMoreMatches() &&
                    destMatchesSrc(destItem.sequenceItem.item, srcItem.sequenceItem.item)) ||
                // destType matches zero src
                (destItem === undefined && srcItem !== undefined && srcItem.isSkippable()) ||
                // srcType matches zero dest
                (destItem !== undefined && destItem.isSkippable() && srcItem === undefined)
            );
        }

        accumulate(
            destType: SequenceItemMatchTracker<DestType> | undefined,
            srcType: SequenceItemMatchTracker<SrcType> | undefined
        ): this {
            const copy = this.copy();

            if (destType !== undefined && srcType !== undefined) {
                copy._withLastAcc(
                    (/* onEmpty */) => {
                        copy.acc.push({ destItem: destType.sequenceItem, matchedSrcItems: [srcType.sequenceItem] });
                    },
                    (lastAcc) => {
                        if (destType.sequenceItem === lastAcc.destItem) {
                            lastAcc.matchedSrcItems.push(srcType.sequenceItem);
                        } else {
                            copy.acc.push({ destItem: destType.sequenceItem, matchedSrcItems: [srcType.sequenceItem] });
                        }
                    }
                );
            } else if (destType === undefined && srcType !== undefined) {
                // srcType matches zero dest
                // do nothing
            } else if (destType !== undefined && srcType === undefined) {
                // destType matches zero src
                copy._withLastAcc(
                    (/* onEmpty */) => {
                        copy.acc.push({ destItem: destType.sequenceItem, matchedSrcItems: [] });
                    },
                    (lastAcc) => {
                        if (destType.sequenceItem !== lastAcc.destItem) {
                            copy.acc.push({ destItem: destType.sequenceItem, matchedSrcItems: [] });
                        }
                    }
                );
            }

            return copy;
        }

        copy(): this {
            const cp = new MatchAccumulateSequenceAccumulator();
            cp.acc = this.acc.map((acc) => ({
                destItem: acc.destItem,
                matchedSrcItems: [...acc.matchedSrcItems],
            }));
            return cp as this;
        }

        toString(): string {
            return `{${this.acc
                .map((acc) => `${destItemStr(acc.destItem)} == [${acc.matchedSrcItems.map(srcItemStr).join(';')}]`)
                .join(';')}}`;
        }

        private _withLastAcc<R>(onEmpty: () => R, withLast: (last: DestItemMatches<DestType, SrcType>) => R) {
            if (this.acc.length === 0) {
                return onEmpty();
            } else {
                return withLast(this.acc[this.acc.length - 1]);
            }
        }
    }

    const acc = traverseAccumulateSequence(
        destSequence.map((destItem) => new SequenceItemMatchTracker(destItem)),
        srcSequence.map((srcItem) => new SequenceItemMatchTracker(srcItem)),
        new MatchAccumulateSequenceAccumulator(),
        destStr,
        srcStr,
        recursionCount
    );

    return acc?.value;
}

export function getCommonSequence<DestType, SrcType, CommonType>(
    destSequence: SequenceItem<DestType>[],
    srcSequence: SequenceItem<SrcType>[],
    getCommon: (
        dest: SequenceItem<DestType> | undefined,
        src: SequenceItem<SrcType> | undefined
    ) => SequenceItem<CommonType> | undefined,
    destStr: (dest: DestType | undefined) => string,
    srcStr: (src: SrcType | undefined) => string,
    commonStr: (common: CommonType | undefined) => string,
    recursionCount: number
): SequenceItem<CommonType>[] | undefined {
    const commonItemStr = getItemToStringFunction(commonStr);
    class CommonSequenceAccumulator implements SequenceAccumulator<DestType, SrcType, SequenceItem<CommonType>[]> {
        acc: SequenceItem<CommonType>[];

        constructor() {
            this.acc = [];
        }

        get value(): SequenceItem<CommonType>[] {
            return this.acc;
        }

        matches(
            dest: SequenceItemMatchTracker<DestType> | undefined,
            src: SequenceItemMatchTracker<SrcType> | undefined
        ): boolean {
            return getCommon(dest?.sequenceItem, src?.sequenceItem) !== undefined;
        }

        accumulate(
            dest: SequenceItemMatchTracker<DestType> | undefined,
            src: SequenceItemMatchTracker<SrcType> | undefined
        ): this {
            const copy = this.copy();
            const common = getCommon(dest?.sequenceItem, src?.sequenceItem);
            if (
                common !== undefined &&
                (copy.acc.length === 0 ||
                    !SequenceItem.isRepeated(common) ||
                    !SequenceItem.isRepeated(copy.acc[this.acc.length - 1]) ||
                    copy.acc[copy.acc.length - 1] !== common)
            ) {
                copy.acc.push(common);
            }
            return copy;
        }

        copy(): this {
            const cp = new CommonSequenceAccumulator();
            cp.acc = [...this.acc];
            return cp as this;
        }

        toString(): string {
            return `[${this.acc.map(commonItemStr).join(';')}]`;
        }
    }

    const acc = traverseAccumulateSequence(
        destSequence.map((destItem) => new SequenceItemMatchTracker(destItem)),
        srcSequence.map((srcItem) => new SequenceItemMatchTracker(srcItem)),
        new CommonSequenceAccumulator(),
        destStr,
        srcStr,
        recursionCount
    );

    return acc?.value;
}

// Two sequences with non-repeating dimensions match if they have the same length and corresponding
// entries at the same index match. Repeating dimensions adds complexity to the logic; we cannot
// compare lengths of sequences to decide on matching. However, we can compare lengths of ordered
// traversal steps. In that case, two sequences with possibly repeating dimensions match if there
// are at least two complete and ordered traversals, one traversal per sequence, with same length
// of steps, covering all items in the original sequence (hence complete) in the same order of items
// in the original sequence (hence ordered), and with matching corresponding entries per step index.
//
// Traversal of a sequence of type arguments (e.g. [Dimension, BatchDim, *Dimensions, ...])
// can be represented as a traversal on a directed graph, such that a node represents a state
// of traversal and an edge represents a dimension that acts as a condition to determine the
// next state of traversal.
//
// For the sequence [A, B, C, D], one state could be the initial state where we enter the
// sequence, another state could be the final state where we terminate traversal at end
// of the sequence, another state could be an intermediate state that we have reached
// dimension B after A and we are ready to go to dimension C ...
//
// A non-repeating dimension has a single condition (or outgoing edge), it transitions the current
// state to a single next state.
// A repeating dimension has two conditions (or outgoing edges), it transitions the current state
// back to itself or to a single next state.
//
// The non-minimized traversal graph is a chain of nodes with no loops involving more than one node.
// This implies that we can traverse the graph from start to end passing by all nodes.
//
// If we could find any two matching traversals, then we could decide that both sequences match.
//
// This step function is a recursive function for searching two graphs for matching traversals.
// At any time t (a step index in the traversal sequence), we keep an index i and an index j of
// the current traversed nodes of both graphs. Each node i (or j) has possible next steps; if it
// is a non-repeating node, then it has only one next step: the next node in the sequence (i + 1),
// if it is a repeating node, then it has two possible next steps: the next node in the sequence
// (i + 1) or back to itself (i). At each traversal step, we consider all possible next steps
// , and we select the first one leading to a match.
//
// Repeated nodes could have zero or more matches. In case of zero match, the repeated node acts as
// a skip connection between both nodes it is connecting (i.e. previous and next). In that case, a
// repeated node adds one more skip edge from previous node to next node.
//
// If a traversal reaches the end of both graphs, then we conclude a match. Otherwise, a traversal
// can be early terminated:
// - if current nodes i and j are not matching
// - either one of the graph has reached the end node while the other has not
// - a special case is when a graph has reached the end node while the other
//   has repeating nodes before the end node, in this case we consider the
//   repeating nodes are matching for 0 occurrences in the other sequence
//
// [B, S] VS [d*, B, S]
// _E0: epsilon_0, is the start condition
//  _E: epsilon, is the termination condition
//  _S: is the skip condition
//
//  _E0      B       S      _E
// ----->()----->()----->()----->
//       ..
//       || d*
//  _E0  v|  B       S      _E
// -.--->()----.>()----->()----->
//   \......../
//       _S
export function traverseAccumulateSequence<A, B, Acc>(
    a_sequence: SequenceItemMatchTracker<A>[],
    b_sequence: SequenceItemMatchTracker<B>[],
    acc: SequenceAccumulator<A, B, Acc>,
    a_str: (a: A | undefined) => string,
    b_str: (b: B | undefined) => string,
    recursionCount: number
): SequenceAccumulator<A, B, Acc> | undefined {
    /**
      This is a complex operation that concurrently traverses two sequences list[A] and list[B],
      reducing pairs of elements (A, B) into a value C at each traversal step, accumulating reduced
      elements C's into a value Acc along the traversal path/sequence.

      Traversal begins at start of both sequences and terminates at end of both sequences. It is not
      necessary for both sequences to have the same length as elements could be marked as repeated.
      Repeated elements contribute zero or more times to the accumulated results as they can appear
      in zero or more reducable pairs. I.e. a repeating element from one sequence can coincide with
      zero or more element from the other sequence.

      A traversal is discarded and considered not accumulatable at a certain step if there is no
      reducable pairs in the next step, i.e. all next/1-hop (A, B) pairs reduce to None. This function
      returns accumulation of the first encountered accumulatable traversal.
    */
    const spaces = ' '.repeat(recursionCount);
    const baseline = function (indent: string, content: string) {
        console.debug(`${spaces}[acc_sequence] ${indent}${content}`);
        return;
    };

    const aa_str = getItemTrackerToStringFunction(a_str);
    const bb_str = getItemTrackerToStringFunction(b_str);

    baseline('', `[${a_sequence.map(aa_str).join(';')}] ==?== [${b_sequence.map(bb_str).join(';')}]`);

    const step = function (
        i: number,
        j: number,
        a_i: SequenceItemMatchTracker<A> | undefined,
        b_j: SequenceItemMatchTracker<B> | undefined,
        acc: SequenceAccumulator<A, B, Acc>,
        indent: string,
        left: (SequenceItemMatchTracker<A> | undefined)[],
        right: (SequenceItemMatchTracker<B> | undefined)[]
    ): SequenceAccumulator<A, B, Acc> | undefined {
        const line = function (content: string) {
            return baseline(indent, content);
        };

        const i_next = i + 1;
        const j_next = j + 1;
        const a_i_next = i_next < a_sequence.length ? a_sequence[i_next] : undefined;
        const b_j_next = j_next < b_sequence.length ? b_sequence[j_next] : undefined;

        line(
            `step(${left.map(aa_str).join(', ')} <=> ${right.map(bb_str).join(', ')} || ${i}: ${aa_str(
                a_i
            )}, ${j}: ${bb_str(b_j)})`
        );

        if (i >= 0 && j >= 0) {
            // both have terminated, that's a match
            if (a_i === undefined && b_j === undefined) {
                line('[ACCEPT] both terminated');
                return acc;
            }

            // i has terminated while j has not
            if (a_i === undefined && b_j !== undefined) {
                // if j is repeated (0 or more) just consume it (j + 1)
                if (b_j.isSkippable()) {
                    if (acc.matches(undefined, b_j)) {
                        line('* i terminated but j is repeated');
                        return step(
                            i,
                            j_next,
                            a_i,
                            b_j_next,
                            acc.accumulate(undefined, b_j),
                            indent + '-',
                            [...left, a_i],
                            [...right, b_j]
                        );
                    } else {
                        line('[REJECT] i terminated and j is repeated but not accepted');
                        return undefined;
                    }
                } else {
                    line('[REJECT] i terminated but j is not');
                    return undefined;
                }
            }

            // j has terminated while i has not
            if (a_i !== undefined && b_j === undefined) {
                // if i is repeated (0 or more) just consume it (i + 1)
                if (a_i.isSkippable()) {
                    if (acc.matches(a_i, undefined)) {
                        line('* j terminated but i is repeated');
                        return step(
                            i_next,
                            j,
                            a_i_next,
                            b_j,
                            acc.accumulate(a_i, undefined),
                            indent + '-',
                            [...left, a_i],
                            [...right, b_j]
                        );
                    } else {
                        line('[REJECT] j terminated and i is repeated but not accepted');
                        return undefined;
                    }
                } else {
                    line('[REJECT] j terminated but i is not');
                    return undefined;
                }
            }

            // break on mismatch
            if (!acc.matches(a_i, b_j)) {
                line('[REJECT] i and j are not reducable');
                return undefined;
            }
        }

        a_i = a_i?.matched();
        b_j = b_j?.matched();

        // now consider all possible next steps
        // if the other node, b_j, is repeated, we add a skip edge from (j - 1) to (j + 1)
        // which is equivalent to moving from (i - 1, j - 1) to (i, j + 1)
        // which means that if we were at node (j - 1), one of the possible steps is to jump
        // to node (j + 1), or equivalently, if we are at node i and node j is repeated,
        // we can stay at node i and just move to next node (j + 1)
        const getNextStepsForItem = function <T>(
            i: number,
            t_i: SequenceItemMatchTracker<T> | undefined,
            t_i_next: SequenceItemMatchTracker<T> | undefined,
            t_sequence: SequenceItemMatchTracker<T>[]
        ) {
            // Note: this order of steps imples greedy/eager matching
            const t_steps = [
                ...(t_i?.hasMoreMatches() ? [{ index: i, item: t_i }] : []),
                { index: i + 1, item: t_i_next },
            ];
            // There may be a streak of skippable items,
            // we need to consider all cases, i.e.:
            // - when next item is skipped
            // - when next and after next item are skipped
            // - when next, after next, and item after that are all skipped
            // - ...
            for (let k = i + 1; k < t_sequence.length - 1 && t_sequence[k].isSkippable(); k++) {
                t_steps.push({ index: k + 1, item: t_sequence[k + 1] });
            }
            return t_steps;
        };

        const a_steps = getNextStepsForItem(i, a_i, a_i_next, a_sequence);
        const b_steps = getNextStepsForItem(j, b_j, b_j_next, b_sequence);

        // be careful not to stay at the same state where (i, j) = (a_step, b_step)
        const steps = a_steps.flatMap((a_step) =>
            b_steps.flatMap((b_step) => (a_step.index !== i || b_step.index !== j ? [{ a_step, b_step }] : []))
        );
        line(`* steps: ${steps.map((s) => `(${s.a_step.index}, ${s.b_step.index})`).join(', ')}`);
        for (const next_step of steps) {
            let new_acc = acc;
            let new_left = left;
            let new_right = right;

            if (i >= 0 && j >= 0) {
                // Accept, and accumulate the current step
                new_acc = new_acc.accumulate(a_i, b_j);
                new_left = [...new_left, a_i];
                new_right = [...new_right, b_j];
            }

            // Handle skip connections; if we are staying at a non-repeating node, we shouldn't accumulate it twice
            if (next_step.a_step.index >= i + 2) {
                // Skip, but match a_i_next with nothing
                for (let k = i + 1; k < next_step.a_step.index; k++) {
                    new_acc = new_acc.accumulate(a_sequence[k], undefined);
                    new_left.push(a_sequence[k]);
                    new_right.push(undefined);
                }
            } else if (next_step.b_step.index >= j + 2) {
                // Skip, but match b_j_next with nothing
                for (let k = j + 1; k < next_step.b_step.index; k++) {
                    new_acc = new_acc.accumulate(undefined, b_sequence[k]);
                    new_left.push(undefined);
                    new_right.push(b_sequence[k]);
                }
            }

            // we have found a match in one of the possible next steps
            const step_res = step(
                next_step.a_step.index,
                next_step.b_step.index,
                next_step.a_step.item,
                next_step.b_step.item,
                new_acc,
                indent + '-',
                new_left,
                new_right
            );
            if (step_res !== undefined) {
                return step_res;
            }
        }
        // no matches found in any possible next step
        line('[REJECT] no matches found in any possible next step');
        return undefined;
    };

    const result = step(-1, -1, undefined, undefined, acc, '', [], []);

    baseline(
        '',
        `[${a_sequence.map(aa_str).join(';')}] ==?== [${b_sequence.map(bb_str).join(';')}] ==> ${result?.toString()}`
    );

    return result;
}
