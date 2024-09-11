/*
 * sequenceMatching.ts
 * Licensed under the MIT license.
 * Author: Ahmed Mahran
 *
 * Provides generic logic for matching two sequences and associating corresponding elements.
 */

export interface SequenceAccumulator<DestType, SrcType, Acc> {
    get value(): Acc;

    // Returns false if DestType and SrcType are not reducable.
    matches(dest: DestType | undefined, src: SrcType | undefined): boolean;

    // Reduces DestType and SrcType and accumulates result into Acc.
    // Returns a copy of this with new accumulation.
    accumulate(dest: DestType | undefined, src: SrcType | undefined): this;

    copy(): this;

    toString(): string;
}

export function matchSequence<DestType, SrcType>(
    destSequence: DestType[],
    srcSequence: SrcType[],
    isRepeatedDest: (dest: DestType | undefined) => boolean,
    isRepeatedSrc: (src: SrcType | undefined) => boolean,
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

        matches(dest: DestType | undefined, src: SrcType | undefined): boolean {
            return (
                (dest !== undefined && src !== undefined && destMatchesSrc(dest, src)) ||
                (dest === undefined && isRepeatedSrc(src)) ||
                (isRepeatedDest(dest) && src === undefined)
            );
        }

        accumulate(dest: DestType | undefined, src: SrcType | undefined): this {
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
        destSequence,
        srcSequence,
        isRepeatedDest,
        isRepeatedSrc,
        new MatchSequenceAccumulator(),
        destStr,
        srcStr,
        recursionCount
    );

    return acc?.value === true;
}

export function matchAccumulateSequence<DestType, SrcType>(
    destSequence: DestType[],
    srcSequence: SrcType[],
    isRepeatedDest: (dest: DestType | undefined) => boolean,
    isRepeatedSrc: (src: SrcType | undefined) => boolean,
    destMatchesSrc: (dest: DestType, src: SrcType) => boolean,
    destStr: (dest: DestType | undefined) => string,
    srcStr: (src: SrcType | undefined) => string,
    recursionCount: number
): { destSequence: DestType[]; srcSequence: SrcType[] }[] | undefined {
    class MatchAccumulateSequenceAccumulator
        implements SequenceAccumulator<DestType, SrcType, { destSequence: DestType[]; srcSequence: SrcType[] }[]>
    {
        acc: { destSequence: DestType[]; srcSequence: SrcType[] }[];

        constructor() {
            this.acc = [];
        }

        get value(): { destSequence: DestType[]; srcSequence: SrcType[] }[] {
            return this.acc;
        }

        matches(destType: DestType | undefined, srcType: SrcType | undefined): boolean {
            return (
                (destType !== undefined && srcType !== undefined && destMatchesSrc(destType, srcType)) ||
                // destType matches zero src
                (destType === undefined && isRepeatedSrc(srcType)) ||
                // srcType matches zero dest
                (isRepeatedDest(destType) && srcType === undefined)
            );
        }

        accumulate(destType: DestType | undefined, srcType: SrcType | undefined): this {
            const copy = this.copy();
            if (destType !== undefined && srcType !== undefined && destMatchesSrc(destType, srcType)) {
                copy._withLastAcc(
                    (/* onEmpty */) => {
                        copy.acc.push({ destSequence: [destType], srcSequence: [srcType] });
                    },
                    (lastAcc) => {
                        const lastDestType = lastAcc.destSequence[lastAcc.destSequence.length - 1];
                        if ((isRepeatedDest(destType) || isRepeatedDest(lastDestType)) && destType !== lastDestType) {
                            copy.acc.push({ destSequence: [destType], srcSequence: [srcType] });
                        } else {
                            function push<T>(t: T, ts: T[], isRepeated: (t: T | undefined) => boolean) {
                                if (
                                    ts.length === 0 ||
                                    !isRepeated(t) ||
                                    !isRepeated(ts[ts.length - 1]) ||
                                    ts[ts.length - 1] !== t
                                ) {
                                    ts.push(t);
                                }
                            }
                            push(destType, lastAcc.destSequence, isRepeatedDest);
                            lastAcc.srcSequence.push(srcType);
                        }
                    }
                );
            } else if (destType === undefined && srcType !== undefined && isRepeatedSrc(srcType)) {
                // srcType matches zero dest
                // do nothing
            } else if (destType !== undefined && isRepeatedDest(destType) && srcType === undefined) {
                // destType matches zero src
                copy._withLastAcc(
                    (/* onEmpty */) => {
                        copy.acc.push({ destSequence: [destType], srcSequence: [] });
                    },
                    (lastAcc) => {
                        const lastDestType = lastAcc.destSequence[lastAcc.destSequence.length - 1];
                        if (destType !== lastDestType) {
                            copy.acc.push({ destSequence: [destType], srcSequence: [] });
                        }
                    }
                );
            }

            return copy;
        }

        copy(): this {
            const cp = new MatchAccumulateSequenceAccumulator();
            cp.acc = this.acc.map((acc) => ({
                destSequence: [...acc.destSequence],
                srcSequence: [...acc.srcSequence],
            }));
            return cp as this;
        }

        toString(): string {
            return `{${this.acc
                .map(
                    (acc) =>
                        `[${acc.destSequence.map(destStr).join(';')}] == [${acc.srcSequence.map(srcStr).join(';')}]`
                )
                .join(';')}}`;
        }

        private _withLastAcc<R>(
            onEmpty: () => R,
            withLast: (last: { destSequence: DestType[]; srcSequence: SrcType[] }) => R
        ) {
            if (this.acc.length === 0) {
                return onEmpty();
            } else {
                return withLast(this.acc[this.acc.length - 1]);
            }
        }
    }

    const acc = traverseAccumulateSequence(
        destSequence,
        srcSequence,
        isRepeatedDest,
        isRepeatedSrc,
        new MatchAccumulateSequenceAccumulator(),
        destStr,
        srcStr,
        recursionCount
    );

    return acc?.value;
}

export function getCommonSequence<DestType, SrcType, CommonType>(
    destSequence: DestType[],
    srcSequence: SrcType[],
    isRepeatedDest: (dest: DestType | undefined) => boolean,
    isRepeatedSrc: (src: SrcType | undefined) => boolean,
    isRepeatedCommon: (common: CommonType | undefined) => boolean,
    getCommon: (dest: DestType | undefined, src: SrcType | undefined) => CommonType | undefined,
    destStr: (dest: DestType | undefined) => string,
    srcStr: (src: SrcType | undefined) => string,
    commonStr: (common: CommonType | undefined) => string,
    recursionCount: number
): CommonType[] | undefined {
    class CommonSequenceAccumulator implements SequenceAccumulator<DestType, SrcType, CommonType[]> {
        acc: CommonType[];

        constructor() {
            this.acc = [];
        }

        get value(): CommonType[] {
            return this.acc;
        }

        matches(dest: DestType | undefined, src: SrcType | undefined): boolean {
            return getCommon(dest, src) !== undefined;
        }

        accumulate(dest: DestType | undefined, src: SrcType | undefined): this {
            const copy = this.copy();
            const common = getCommon(dest, src);
            if (
                common !== undefined &&
                (copy.acc.length === 0 ||
                    !isRepeatedCommon(common) ||
                    !isRepeatedCommon(copy.acc[this.acc.length - 1]) ||
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
            return `[${this.acc.map(commonStr).join(';')}]`;
        }
    }

    const acc = traverseAccumulateSequence(
        destSequence,
        srcSequence,
        isRepeatedDest,
        isRepeatedSrc,
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
    a_sequence: A[],
    b_sequence: B[],
    is_repeated_a: (a: A | undefined) => boolean,
    is_repeated_b: (b: B | undefined) => boolean,
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

    baseline('', `[${a_sequence.map(a_str).join(';')}] ==?== [${b_sequence.map(b_str).join(';')}]`);

    const step = function (
        i: number,
        j: number,
        acc: SequenceAccumulator<A, B, Acc>,
        indent: string,
        left: (A | undefined)[],
        right: (B | undefined)[]
    ): SequenceAccumulator<A, B, Acc> | undefined {
        const line = function (content: string) {
            return baseline(indent, content);
        };

        const a_i = i >= 0 && i < a_sequence.length ? a_sequence[i] : undefined;
        const b_j = j >= 0 && j < b_sequence.length ? b_sequence[j] : undefined;
        const is_repeated_a_i = is_repeated_a(a_i);
        const is_repeated_b_j = is_repeated_b(b_j);

        const i_next = i + 1;
        const j_next = j + 1;
        const a_i_next = i_next < a_sequence.length ? a_sequence[i_next] : undefined;
        const b_j_next = j_next < b_sequence.length ? b_sequence[j_next] : undefined;
        const is_repeated_a_i_next = is_repeated_a(a_i_next);
        const is_repeated_b_j_next = is_repeated_b(b_j_next);

        line(
            `step(${left.map(a_str).join(', ')} <=> ${right.map(b_str).join(', ')} || ${i}: ${a_str(
                a_i
            )}, ${j}: ${b_str(b_j)})`
        );

        if (i >= 0 && j >= 0) {
            // both have terminated, that's a match
            if (a_i === undefined && b_j === undefined) {
                line('[ACCEPT] both terminated');
                return acc;
            }

            // i has terminated while j has not
            if (a_i === undefined) {
                // if j is repeated (0 or more) just consume it (j + 1)
                if (is_repeated_b_j) {
                    if (acc.matches(undefined, b_j)) {
                        line('* i terminated but j is repeated');
                        return step(
                            i,
                            j + 1,
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
            if (b_j === undefined) {
                // if i is repeated (0 or more) just consume it (i + 1)
                if (is_repeated_a_i) {
                    if (acc.matches(a_i, undefined)) {
                        line('* j terminated but i is repeated');
                        return step(
                            i + 1,
                            j,
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

        // now consider all possible next steps
        // if the other node, b_j, is repeated, we add a skip edge from (j - 1) to (j + 1)
        // which is equivalent to moving from (i - 1, j - 1) to (i, j + 1)
        // which means that if we were at node (j - 1), one of the possible steps is to jump
        // to node (j + 1), or equivalently, if we are at node i and node j is repeated,
        // we can stay at node i and just move to next node (j + 1)
        const t_i_steps = [
            ...(is_repeated_a_i ? [i] : []),
            i + 1,
            ...(is_repeated_a_i_next && i + 2 < a_sequence.length ? [i + 2] : []),
        ];
        const t_j_steps = [
            ...(is_repeated_b_j ? [j] : []),
            j + 1,
            ...(is_repeated_b_j_next && j + 2 < b_sequence.length ? [j + 2] : []),
        ];
        // be careful not to stay at the same state where (i, j) = (i_step, j_step)
        const steps = t_i_steps.flatMap((i_step) =>
            t_j_steps.flatMap((j_step) => (i_step !== i || j_step !== j ? [{ i_step, j_step }] : []))
        );
        line(`* steps: ${steps.map((s) => `(${s.i_step}, ${s.j_step})`).join(', ')}`);
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
            if (next_step.i_step === i + 2 && /* redundant; implied */ is_repeated_a_i_next) {
                // Skip, but match a_i_next with nothing
                new_acc = new_acc.accumulate(a_i_next, undefined);
                new_left.push(a_i_next);
                new_right.push(undefined);
            } else if (next_step.j_step === j + 2 && /* redundant; implied */ is_repeated_b_j_next) {
                // Skip, but match b_j_next with nothing
                new_acc = new_acc.accumulate(undefined, b_j_next);
                new_left.push(undefined);
                new_right.push(b_j_next);
            }

            // we have found a match in one of the possible next steps
            const step_res = step(next_step.i_step, next_step.j_step, new_acc, indent + '-', new_left, new_right);
            if (step_res !== undefined) {
                return step_res;
            }
        }
        // no matches found in any possible next step
        return undefined;
    };

    const result = step(-1, -1, acc, '', [], []);

    baseline(
        '',
        `[${a_sequence.map(a_str).join(';')}] ==?== [${b_sequence.map(b_str).join(';')}] ==> ${result?.toString()}`
    );

    return result;
}
