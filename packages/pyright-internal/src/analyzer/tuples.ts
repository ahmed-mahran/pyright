/*
 * tuples.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Provides special-case logic for type analysis of tuples.
 */

import { fail } from '../common/debug';
import { DiagnosticAddendum } from '../common/diagnostic';
import { DiagnosticRule } from '../common/diagnosticRules';
import { LocAddendum, LocMessage } from '../localization/localize';
import { ExpressionNode, ParseNodeType, SliceNode, TupleNode } from '../parser/parseNodes';
import { addConstraintsForExpectedType, assignTypeVar as doAssignTypeVar } from './constraintSolver';
import { ConstraintTracker } from './constraintTracker';
import { MyPyrightExtensions } from './mypyrightExtensionsUtils';
import { getTypeVarScopesForNode } from './parseTreeUtils';
import { DestItemMatches, matchAccumulateSequence } from './sequenceMatching';
import { AssignTypeFlags, EvalFlags, maxInferredContainerDepth, TypeEvaluator, TypeResult } from './typeEvaluatorTypes';
import {
    AnyType,
    ClassType,
    combineTypes,
    hasTypeVar,
    isAny,
    isAnyOrUnknown,
    isAnyUnknownOrObject,
    isClass,
    isClassInstance,
    isInstantiableClass,
    isTypeSame,
    isTypeVar,
    isTypeVarTuple,
    isUnion,
    isUnpacked,
    isUnpackedTypeVarTuple,
    TupleTypeArg,
    Type,
    TypeBase,
    TypeVarKind,
    TypeVarTulpeIndexedVar,
    TypeVarTupleSubscript,
    TypeVarTupleSubscriptKind,
    TypeVarTupleType,
    TypeVarType,
    UnknownType,
} from './types';
import {
    convertToInstance,
    getContainerDepth,
    InferenceContext,
    isLiteralType,
    isTupleClass,
    isTupleGradualForm,
    isTypeVarSame,
    isUnboundedTupleClass,
    makeInferenceContext,
    mapSubtypes,
    specializeTupleClass,
    transformPossibleRecursiveTypeAlias,
} from './typeUtils';

// If a tuple expression with no declared type contains a large number
// of elements, it can cause performance issues. This value limits the
// number of elements that will be included in the tuple type before
// we default to tuple[Unknown, ...].
const maxInferredTupleEntryCount = 256;

export function makeTupleObject(evaluator: TypeEvaluator, typeArgs: TupleTypeArg[], isUnpacked = false) {
    const tupleClass = evaluator.getTupleClassType();
    if (tupleClass && isInstantiableClass(tupleClass)) {
        return convertToInstance(specializeTupleClass(tupleClass, typeArgs, /* isTypeArgExplicit */ true, isUnpacked));
    }

    return UnknownType.create();
}

export function getTypeOfTuple(
    evaluator: TypeEvaluator,
    node: TupleNode,
    flags: EvalFlags,
    inferenceContext: InferenceContext | undefined,
    constraints: ConstraintTracker | undefined
): TypeResult {
    if ((flags & EvalFlags.TypeExpression) !== 0 && node.parent?.nodeType !== ParseNodeType.Argument) {
        // This is allowed inside of an index trailer, specifically
        // to support Tuple[()], which is the documented way to annotate
        // a zero-length tuple.
        const diag = new DiagnosticAddendum();
        diag.addMessage(LocAddendum.useTupleInstead());
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.tupleInAnnotation() + diag.getString(),
            node
        );

        return { type: UnknownType.create() };
    }

    if ((flags & EvalFlags.InstantiableType) !== 0 && node.d.items.length === 0 && !inferenceContext) {
        return { type: makeTupleObject(evaluator, []), isEmptyTupleShorthand: true };
    }

    flags &= ~(EvalFlags.TypeExpression | EvalFlags.StrLiteralAsType | EvalFlags.InstantiableType);

    // If the expected type is a union, recursively call for each of the subtypes
    // to find one that matches.
    const expectedType = inferenceContext?.expectedType;
    let expectedTypeContainsAny = inferenceContext && isAny(inferenceContext.expectedType);
    let expectedTypeDiagAddendum: DiagnosticAddendum | undefined;

    if (expectedType && isUnion(expectedType)) {
        let foundSomeMatches: boolean = false;
        let isIncomplete: boolean = false;
        const allSubtypesConstrains: ConstraintTracker[] = [];
        const diags: DiagnosticAddendum[] = [];

        const type = mapSubtypes(
            expectedType,
            (subtype) => {
                if (isAny(subtype)) {
                    expectedTypeContainsAny = true;
                }

                const clonedConstraints = constraints?.clone();
                const subtypeResult = evaluator.useSpeculativeMode(node, () => {
                    return getTypeOfTupleWithContext(
                        evaluator,
                        node,
                        flags,
                        makeInferenceContext(subtype),
                        clonedConstraints
                    );
                });

                const subDiag = subtypeResult?.expectedTypeDiagAddendum;

                if (
                    subtypeResult &&
                    !subtypeResult.typeErrors &&
                    evaluator.assignType(subtype, subtypeResult.type, subDiag)
                ) {
                    foundSomeMatches = true;
                    if (subtypeResult.isIncomplete) {
                        isIncomplete = true;
                    }
                    if (clonedConstraints) {
                        allSubtypesConstrains.push(clonedConstraints);
                    }
                    if (subDiag) {
                        diags.push(subDiag);
                    }
                    return subtype;
                }

                return undefined;
            },
            { sortSubtypes: true }
        );

        if (foundSomeMatches) {
            if (constraints) {
                constraints.addCombinedConstraints(allSubtypesConstrains);
            }
            return { type, isIncomplete };
        } else if (diags.length === 1) {
            expectedTypeDiagAddendum = diags[0];
        } else if (diags.length > 1) {
            expectedTypeDiagAddendum = new DiagnosticAddendum();
            diags.forEach((diag) => expectedTypeDiagAddendum?.addAddendum(diag));
        }
    } else if (expectedType) {
        const result = getTypeOfTupleWithContext(
            evaluator,
            node,
            flags,
            makeInferenceContext(expectedType),
            constraints
        );

        if (result && !result.typeErrors) {
            return result;
        }

        expectedTypeDiagAddendum = result?.expectedTypeDiagAddendum;
    }

    const typeResult = getTypeOfTupleInferred(evaluator, node, flags);

    // If there was an expected type of Any, replace the resulting type
    // with Any rather than return a type with unknowns.
    if (expectedTypeContainsAny) {
        typeResult.type = AnyType.create();
    }

    return { ...typeResult, expectedTypeDiagAddendum };
}

export function getTypeOfTupleWithContext(
    evaluator: TypeEvaluator,
    node: TupleNode,
    flags: EvalFlags,
    inferenceContext: InferenceContext,
    constraints: ConstraintTracker | undefined
): TypeResult | undefined {
    inferenceContext.expectedType = transformPossibleRecursiveTypeAlias(evaluator, inferenceContext.expectedType);
    if (!isClassInstance(inferenceContext.expectedType)) {
        return undefined;
    }

    const tupleClass = evaluator.getTupleClassType();
    if (!tupleClass || !isInstantiableClass(tupleClass)) {
        return undefined;
    }

    // Build an array of expected types.
    let expectedTypes: Type[] = [];

    if (isTupleClass(inferenceContext.expectedType) && inferenceContext.expectedType.priv.tupleTypeArgs) {
        expectedTypes = inferenceContext.expectedType.priv.tupleTypeArgs.map((t) =>
            transformPossibleRecursiveTypeAlias(evaluator, t.type)
        );
        const unboundedIndex = inferenceContext.expectedType.priv.tupleTypeArgs.findIndex((t) => t.isUnbounded);
        if (unboundedIndex >= 0) {
            if (expectedTypes.length > node.d.items.length) {
                expectedTypes.splice(unboundedIndex, 1);
            } else {
                while (expectedTypes.length < node.d.items.length) {
                    expectedTypes.splice(unboundedIndex, 0, expectedTypes[unboundedIndex]);
                }
            }
        }
    } else {
        const tupleConstraints = constraints ?? new ConstraintTracker(evaluator);
        if (
            !addConstraintsForExpectedType(
                evaluator,
                ClassType.cloneAsInstance(tupleClass),
                inferenceContext.expectedType,
                tupleConstraints,
                getTypeVarScopesForNode(node),
                node.start
            )
        ) {
            return undefined;
        }

        const specializedTuple = evaluator.solveAndApplyConstraints(tupleClass, tupleConstraints) as ClassType;
        if (!specializedTuple.priv.typeArgs || specializedTuple.priv.typeArgs.length !== 1) {
            return undefined;
        }

        const homogenousType = transformPossibleRecursiveTypeAlias(evaluator, specializedTuple.priv.typeArgs[0]);
        for (let i = 0; i < node.d.items.length; i++) {
            expectedTypes.push(homogenousType);
        }
    }

    const entryTypeResults = node.d.items.map((expr, index) =>
        evaluator.getTypeOfExpression(
            expr,
            flags | EvalFlags.StripTupleLiterals,
            constraints,
            makeInferenceContext(
                index < expectedTypes.length ? expectedTypes[index] : undefined,
                inferenceContext.isTypeIncomplete
            )
        )
    );
    const isIncomplete = entryTypeResults.some((result) => result.isIncomplete);
    const typeErrors = entryTypeResults.some((result) => result.typeErrors);

    // Copy any expected type diag addenda for precision error reporting.
    let expectedTypeDiagAddendum: DiagnosticAddendum | undefined;
    if (entryTypeResults.some((result) => result.expectedTypeDiagAddendum)) {
        expectedTypeDiagAddendum = new DiagnosticAddendum();
        entryTypeResults.forEach((result) => {
            if (result.expectedTypeDiagAddendum) {
                expectedTypeDiagAddendum!.addAddendum(result.expectedTypeDiagAddendum);
            }
        });
    }

    // If the tuple contains a very large number of entries, it's probably
    // generated code. If we encounter type errors, don't bother building
    // the full tuple type.
    let type: Type;
    if (node.d.items.length > maxInferredTupleEntryCount && entryTypeResults.some((result) => result.typeErrors)) {
        type = makeTupleObject(evaluator, [{ type: UnknownType.create(), isUnbounded: true }]);
    } else {
        type = makeTupleObject(evaluator, evaluator.buildTupleTypesList(entryTypeResults, /* stripLiterals */ false));
    }

    return { type, typeErrors, expectedTypeDiagAddendum, isIncomplete };
}

export function getTypeOfTupleInferred(evaluator: TypeEvaluator, node: TupleNode, flags: EvalFlags): TypeResult {
    const entryTypeResults = node.d.items.map((expr) =>
        evaluator.getTypeOfExpression(expr, flags | EvalFlags.StripTupleLiterals, /* constraints */ undefined)
    );
    const isIncomplete = entryTypeResults.some((result) => result.isIncomplete);

    // If the tuple contains a very large number of entries, it's probably
    // generated code. Rather than taking the time to evaluate every entry,
    // simply return an unknown type in this case.
    if (node.d.items.length > maxInferredTupleEntryCount) {
        return { type: makeTupleObject(evaluator, [{ type: UnknownType.create(), isUnbounded: true }]) };
    }

    const type = makeTupleObject(
        evaluator,
        evaluator.buildTupleTypesList(entryTypeResults, (flags & EvalFlags.StripTupleLiterals) !== 0)
    );

    if (isIncomplete) {
        if (getContainerDepth(type) > maxInferredContainerDepth) {
            return { type: UnknownType.create() };
        }
    }

    return { type, isIncomplete };
}

// Assigns the source type arguments to the dest type arguments. It assumed
// the the caller has already verified that both the dest and source are
// tuple classes.
export function assignTupleTypeArgs(
    evaluator: TypeEvaluator,
    destType: ClassType,
    srcType: ClassType,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number
) {
    function* argsCombinationsIterator(args: TupleTypeArg[], start: number = 0): Generator<TupleTypeArg[]> {
        function* argSubtypesIterator(arg: TupleTypeArg): Generator<TupleTypeArg[]> {
            // First dimension represents parallel alternative of the same arg. If arg is
            // a union, all subtypes are considered as alternatives to generate combinations.
            // Second dimension represents sequential expansions. If arg is unpacked tuple,
            // arg is expanded by replacing the tuple by its unpacked tuple arguments.
            const argsSubtypes: TupleTypeArg[][] = [];
            const type = arg.type;
            if (isUnion(type)) {
                // Union subtypes are parallel options
                const subtypes = type.priv.subtypes;
                for (const subtype of subtypes) {
                    argsSubtypes.push([{ type: subtype, isUnbounded: arg.isUnbounded, isOptional: arg.isOptional }]);
                }
            } else if (isClass(type) && isTupleClass(type) && isUnpacked(type) && !!type.priv.tupleTypeArgs) {
                // Unpacked tuple args are all added as sequential expansion
                argsSubtypes.push(type.priv.tupleTypeArgs);
            } else {
                yield [arg];
                return;
            }
            for (const subtype of argsSubtypes) {
                // A subtype could be a nested union or unpacked tuple, hence we need
                // to generate corresponding combinations.
                for (const subtypeCombination of argsCombinationsIterator(subtype)) {
                    yield subtypeCombination;
                }
            }
        }
        if (start >= args.length || start < 0) {
            yield [];
        } else if (start === args.length - 1) {
            for (const i of argSubtypesIterator(args[start])) {
                yield i;
            }
        } else {
            const headCombinations: TupleTypeArg[][] = [];
            for (const head of argSubtypesIterator(args[start])) {
                headCombinations.push(head);
            }

            for (const tail of argsCombinationsIterator(args, start + 1)) {
                for (const head of headCombinations) {
                    yield [...head, ...tail];
                }
            }
        }
    }

    // We always need to test assignment of srcType to destType based on structural equivalence.
    // This is regardless from whether or not AssignTypeFlags.Contravariant is set.
    // E.g. if srcType inhertis from destType, the assignment from srcType to destType is ok.
    // O.w. if destType inhertis from srcType, the assignment from srcType to destType is not ok.
    // However, if AssignTypeFlags.Contravariant is set, this implies that we need to resolve type
    // variables of the srcType. I.e. we need to find matches from the destType to all type variables
    // of the srcType. Of course, if AssignTypeFlags.Contravariant is not set, we need to resolve
    // type variables of the destType instead.
    // The tuple matching algorithm matches individual dest type variable tuples with src args.
    // I.e. for each individual type var tuple of the dest type we get a set of args from the src
    // tuple. This is why when AssignTypeFlags.Contravariant is set we swap src and dest; to
    // identify src type var tuples instead.
    // However, we still need to perform structural type matching to determine equivalence,
    // so we need to swap back src and dest types. We take case of this in places that we need
    // to test individual args matching.
    const isContra = (flags & AssignTypeFlags.Contravariant) !== 0;
    const effectiveDestType = isContra ? srcType : destType;
    const effectiveSrcType = isContra ? destType : srcType;

    const destTypeArgs = [...(effectiveDestType.priv.tupleTypeArgs ?? [])];
    const srcTypeArgs = [...(effectiveSrcType.priv.tupleTypeArgs ?? [])];

    let isAssignable = false;
    const constraintsFromAssignableCombinations: ConstraintTracker[] = [];
    const diags: DiagnosticAddendum[] = [];

    const srcTypeArgsCombinations: TupleTypeArg[][] = [];
    for (const srcTypeArgsCombination of argsCombinationsIterator(srcTypeArgs)) {
        srcTypeArgsCombinations.push(srcTypeArgsCombination);
    }

    for (const destTypeArgsCombination of argsCombinationsIterator(destTypeArgs)) {
        // Don't evaluate all combinations; just find the first assignable combination
        // and evaluate those with type vars as well to get all possible bounds of the type vars
        if (!isAssignable || destTypeArgsCombination.some((destArg) => hasTypeVar(destArg.type))) {
            for (const srcTypeArgsCombination of srcTypeArgsCombinations) {
                const clonedConstraints = constraints ? constraints.clone() : undefined;
                const newDiag = diag ? new DiagnosticAddendum() : undefined;
                if (
                    assignTupleTypeArgsInternal(
                        evaluator,
                        destTypeArgsCombination,
                        srcTypeArgsCombination,
                        newDiag,
                        clonedConstraints,
                        flags,
                        recursionCount
                    )
                ) {
                    isAssignable = true;
                    if (clonedConstraints) {
                        constraintsFromAssignableCombinations.push(clonedConstraints);
                    }
                } else if (newDiag) {
                    diags.push(newDiag);
                }
            }
        }
    }

    if (constraints && constraintsFromAssignableCombinations.length > 0) {
        constraints.addCombinedConstraints(constraintsFromAssignableCombinations);
    }

    if (!isAssignable && diags.length > 0 && !!diag) {
        diags.forEach((d) => diag.addAddendum(d));
    }

    return isAssignable;
}

export function assignTupleTypeArgsInternal(
    evaluator: TypeEvaluator,
    destTupleTypeArgs: TupleTypeArg[],
    srcTupleTypeArgs: TupleTypeArg[],
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number
) {
    const isContra = (flags & AssignTypeFlags.Contravariant) !== 0;

    // A base case is when all repeated/intederminate args match zero
    function getBaseCase(typeArgs: TupleTypeArg[]) {
        return typeArgs.filter((arg) => !isIndeterminate(arg));
    }

    const destTypeArgs = combineSubscriptedTypeVars(destTupleTypeArgs);
    const srcTypeArgs = combineSubscriptedTypeVars(srcTupleTypeArgs);

    // Handle special case when dest and src are exactly the same
    if (destTypeArgs.length === srcTypeArgs.length) {
        let isTheSame = true;
        for (let i = 0; i < destTypeArgs.length; i++) {
            if (
                !isTypeSame(destTypeArgs[i].type, srcTypeArgs[i].type, { treatBoundScopeIdForTypeVarAsUnBound: true })
            ) {
                isTheSame = false;
                break;
            }
        }
        if (isTheSame) {
            return true;
        }
    }

    const destTypeArgsBaseCase = getBaseCase(destTypeArgs);
    const srcTypeArgsBaseCase = getBaseCase(srcTypeArgs);

    function doMatch(isBaseCase: boolean) {
        return matchTupleTypeArgs(
            evaluator,
            destTypeArgs,
            isBaseCase ? srcTypeArgsBaseCase : srcTypeArgs,
            undefined, //isBaseCase ? undefined : constraints,
            flags,
            recursionCount
        );
    }

    const matchedTypeArgs = doMatch(/* isBaseCase */ false);

    if (matchedTypeArgs !== undefined) {
        // Handle the special case where the dest is a TypeVarTuple
        // and the source is a `*tuple[Any, ...]`. This is allowed.
        const isTupleGradualFormSrcTypeArg =
            srcTypeArgs.length === 1 && isAnyOrUnknown(srcTypeArgs[0].type) && srcTypeArgs[0].isUnbounded;

        // E.g. tuple[*tuple[int, ...], int] is assignable to tuple[*tuple[int, ...]] but
        // not the ineverse case; one-or-more ints is assignable to zero-or-more ints
        // but zero-or-more ints is not assignable to one-or-more ints; because the base
        // case zero int (empty) is not assignable to one-or-more ints while the base case
        // one int is assignable to zero-or-more ints.
        if (
            !isTupleGradualFormSrcTypeArg &&
            srcTypeArgsBaseCase.length < srcTypeArgs.length &&
            doMatch(/* isBaseCase */ true) === undefined
        ) {
            //TODO isSrcIndeterminate is always true
            const isSrcIndeterminate = srcTypeArgs.length > srcTypeArgsBaseCase.length;
            const isDestIndeterminate = destTypeArgs.length > destTypeArgsBaseCase.length;

            if (isSrcIndeterminate && isDestIndeterminate) {
                // tuple size mismatch; expected {destTypeArgsBaseCase.length} or more, but received {srcTypeArgsBaseCase.length} or more
                diag?.addMessage(
                    LocAddendum.tupleSizeMismatchIndeterminate().format({
                        expected: destTypeArgsBaseCase.length,
                        received: srcTypeArgsBaseCase.length,
                    })
                );
            } else if (isSrcIndeterminate && !isDestIndeterminate) {
                // tuple size mismatch; expected {destTypeArgs.length}, but received {srcTypeArgsBaseCase.length} or more
                diag?.addMessage(
                    LocAddendum.tupleSizeMismatchIndeterminateSrc().format({
                        expected: destTypeArgs.length,
                        received: srcTypeArgsBaseCase.length,
                    })
                );
            } else if (!isSrcIndeterminate && isDestIndeterminate) {
                // tuple size mismatch; expected {destTypeArgsBaseCase.length} or more, but received {srcTypeArgs.length}
                diag?.addMessage(
                    LocAddendum.tupleSizeMismatchIndeterminateDest().format({
                        expected: destTypeArgsBaseCase.length,
                        received: srcTypeArgs.length,
                    })
                );
            } else if (!isSrcIndeterminate && !isDestIndeterminate) {
                // tuple size mismatch; expected {destTypeArgs.length}, but received {srcTypeArgs.length}
                diag?.addMessage(
                    LocAddendum.tupleSizeMismatch().format({
                        expected: destTypeArgs.length,
                        received: srcTypeArgs.length,
                    })
                );
            }

            return false;
        }

        if (constraints) {
            function isSingleTypeVarTuple(seq: TupleTypeArg[]) {
                return seq.length === 1 && isTypeVarTuple(seq[0].type);
            }

            const assignTypeVar = function (dest: TypeVarType, src: Type) {
                return doAssignTypeVar(evaluator, dest, src, diag, constraints, flags, recursionCount + 1);
            };
            const assignType = function (dest: Type, src: Type) {
                // For contra assignment, restore original dest and src types
                // for proper structural type matching but keep contra flag
                // as is for proper type var resolution:
                // - resolve type vars of original src type
                // - properly set lower and upper bounds of the type vars
                //   so that type vars are narrower
                const originalDest = isContra ? src : dest;
                const originalSrc = isContra ? dest : src;
                return evaluator.assignType(originalDest, originalSrc, diag, constraints, flags, recursionCount + 1);
            };
            const resolveTypeVars = function (dest: Type, src: Type): boolean | undefined {
                if (isTypeVar(dest)) {
                    return assignTypeVar(dest, src);
                } else if (hasTypeVar(dest) /* || hasTypeVar(src)*/) {
                    return assignType(dest, src);
                }
                return undefined;
            };
            allocateSourceTypeVarTuples(matchedTypeArgs).forEach(({ destArg, srcSequence }) => {
                if (isTypeVarTuple(destArg.type)) {
                    assignTypeVar(
                        destArg.type,
                        isSingleTypeVarTuple(srcSequence)
                            ? srcSequence[0].type
                            : createVariadicTuple(evaluator, srcSequence)
                    );
                } else if (srcSequence.length === 1) {
                    resolveTypeVars(destArg.type, srcSequence[0].type);
                }
            });
        }

        return true;
    } else {
        const originalDestTypeArgs = isContra ? srcTypeArgs : destTypeArgs;
        const originalSrcTypeArgs = isContra ? destTypeArgs : srcTypeArgs;

        if (adjustTupleTypeArgs(evaluator, originalDestTypeArgs, originalSrcTypeArgs, flags)) {
            const clonedConstraints = constraints?.clone();
            for (let argIndex = 0; argIndex < originalSrcTypeArgs.length; argIndex++) {
                const entryDiag = diag?.createAddendum();
                const destArgType = originalDestTypeArgs[argIndex].type;
                const srcArgType = originalSrcTypeArgs[argIndex].type;

                // Handle the special case where the dest is a TypeVarTuple
                // and the source is a `*tuple[Any, ...]`. This is allowed.
                if (
                    isTypeVarTuple(destArgType) &&
                    destArgType.priv.isUnpacked &&
                    !destArgType.priv.isInUnion &&
                    isTupleGradualForm(srcArgType)
                ) {
                    if (clonedConstraints) {
                        constraints?.copyFromClone(clonedConstraints);
                    }
                    return true;
                }

                if (
                    !evaluator.assignType(
                        destArgType,
                        srcArgType,
                        entryDiag?.createAddendum(),
                        clonedConstraints,
                        flags,
                        recursionCount + 1
                    )
                ) {
                    if (entryDiag) {
                        entryDiag.addMessage(
                            LocAddendum.tupleEntryTypeMismatch().format({
                                entry: argIndex + 1,
                            })
                        );
                    }
                    return false;
                }
            }
        } else {
            const isDestIndeterminate = originalDestTypeArgs.some((t) => t.isUnbounded || isTypeVarTuple(t.type));

            if (originalSrcTypeArgs.some((t) => t.isUnbounded || isTypeVarTuple(t.type))) {
                if (isDestIndeterminate) {
                    diag?.addMessage(
                        LocAddendum.tupleSizeIndeterminateSrcDest().format({
                            expected: originalDestTypeArgs.length - 1,
                        })
                    );
                } else {
                    diag?.addMessage(
                        LocAddendum.tupleSizeIndeterminateSrc().format({
                            expected: originalDestTypeArgs.length,
                        })
                    );
                }
            } else {
                if (isDestIndeterminate) {
                    diag?.addMessage(
                        LocAddendum.tupleSizeMismatchIndeterminateDest().format({
                            expected: originalDestTypeArgs.length - 1,
                            received: originalSrcTypeArgs.length,
                        })
                    );
                } else {
                    diag?.addMessage(
                        LocAddendum.tupleSizeMismatch().format({
                            expected: originalDestTypeArgs.length,
                            received: originalSrcTypeArgs.length,
                        })
                    );
                }
            }

            return false;
        }
    }

    return false;
}

function createVariadicTuple(evaluator: TypeEvaluator, typeArgs: TupleTypeArg[]) {
    const tupleClass = evaluator.getTupleClassType();
    if (tupleClass && isInstantiableClass(tupleClass)) {
        const tuple = ClassType.cloneAsInstance(
            specializeTupleClass(
                tupleClass,
                typeArgs.map((typeArg) => {
                    return {
                        type: typeArg.type,
                        isUnbounded: !isUnpackedTypeVarTuple(typeArg.type) && typeArg.isUnbounded,
                        isOptional: typeArg.isOptional,
                    };
                }),
                /* isTypeArgExplicit */ true,
                /* isUnpacked */ true
            )
        );
        tuple.priv.isEmptyContainer = typeArgs.length === 0;
        return tuple;
    }

    fail("Couldn't create a tuple");
}

function isIndeterminate(type: TupleTypeArg | undefined): boolean {
    return (
        type !== undefined &&
        (type.isUnbounded ||
            isTypeVarTuple(type.type) ||
            (isClassInstance(type.type) && isTupleClass(type.type) && !!isUnboundedTupleClass(type.type)))
    );
}

// Matches the source and dest type arguments list such that TypeVarTuples
// from either list are matched to zero or more arguments from the other
// list. Matching is performed in a greedy manner; such that one TypeVarTuple
// from one list matches as most arguments from the other list as possible.
// If no arguments matches for a given TypeVarTuple, then an empty unpacked
// tuple is assumed.
// It returns list of matches, or undefined otherwise.
export function matchTupleTypeArgs(
    evaluator: TypeEvaluator,
    destTypeArgs: TupleTypeArg[],
    srcTypeArgs: TupleTypeArg[],
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number
) {
    const isContra = (flags & AssignTypeFlags.Contravariant) !== 0;

    const toStr = function (type: TupleTypeArg | undefined): string {
        return type !== undefined
            ? `${evaluator.printType(type.type)}${
                  isTypeVar(type.type) ? `${MyPyrightExtensions.printTypeVarBound(evaluator, type.type)}` : ''
              }`
            : 'undefined';
    };

    const memo = new Map<string, boolean>();
    const matches = function (destType: TupleTypeArg | undefined, srcType: TupleTypeArg | undefined): boolean {
        // Here we need to do structural type matching.
        // We need to put back in place the original src and dest types.
        // However, keep AssignTypeFlags.Contravariant in flags as is;
        // we still need to resolve original src type variables and to
        // properly set lower and upper bounds of the type vars so that
        // type vars are narrower.
        const originalDestType = isContra ? srcType : destType;
        const originalSrcType = isContra ? destType : srcType;

        const key = `${toStr(originalDestType)}|${toStr(originalSrcType)}`;
        let res = memo.get(key);
        if (res !== undefined) {
            return res;
        } else if (originalDestType !== undefined && originalSrcType !== undefined) {
            function isUniversal(type: Type): boolean {
                if (isAnyUnknownOrObject(type) || isTupleGradualForm(type, isAnyUnknownOrObject)) {
                    return true;
                }

                if ((isTypeVar(type) && type.shared.kind === TypeVarKind.TypeVar) || isUnpackedTypeVarTuple(type)) {
                    return (
                        //TODO: either freeTypeVar or (bound and constraints) but maybe check whether type is complete
                        (!type.priv.freeTypeVar || isUniversal(type.priv.freeTypeVar)) &&
                        (MyPyrightExtensions.isMappedType(type)
                            ? !type.shared.mappedBoundType || isUniversal(type.shared.mappedBoundType)
                            : !type.shared.boundType || isUniversal(type.shared.boundType)) &&
                        type.shared.constraints.every(isUniversal)
                    );
                }

                return false;
            }
            // Unbound and unconstrained unpacked dest TypeVarTuple
            // can accept:
            // - any singular src
            // - Unbound and unconstrained unpacked src TypeVarTuple
            const isDestUniversalAndSrcUndetermined =
                isUniversal(originalDestType.type) &&
                (!isIndeterminate(originalSrcType) || isUniversal(originalSrcType.type));
            res =
                isDestUniversalAndSrcUndetermined ||
                evaluator.assignType(
                    originalDestType.type,
                    originalSrcType.type,
                    /* diag */ undefined,
                    // We are testing combinations of matches, so we don't want to change any constraints
                    // based on any invalid combinations.
                    constraints ? constraints.clone() : undefined,
                    // // matching repeated VS non-repeated needs to build up new constraints,
                    // // as the repeated element is collecting more non-repeated elements
                    // (isIndeterminate(destType) && isIndeterminate(srcType)) ||
                    //     !(isIndeterminate(destType) || isIndeterminate(srcType))
                    //     ? constraints
                    //     : undefined, // new ConstraintTracker(),
                    flags,
                    recursionCount + 1
                );
            memo.set(key, res);
            return res;
        } else {
            memo.set(key, false);
            return false;
        }
    };

    // // We are testing combinations of matches, so we don't want to change any constraints
    // // based on any invalid combinations.
    // const wasLocked = constraints?.isLocked();
    // if (!wasLocked) {
    //     constraints?.lock();
    // }
    function toSequenceItem(arg: TupleTypeArg) {
        if (isTypeVar(arg.type) && !!arg.type.priv.subscript) {
            return {
                item: arg,
                minMatches: 0,
                maxMatches: TypeVarTupleSubscript.length(arg.type.priv.subscript),
            };
        }
        const indeterminate = isIndeterminate(arg);
        return {
            item: arg,
            minMatches: indeterminate ? 0 : 1,
            maxMatches: indeterminate ? undefined : 1,
        };
    }

    const matchedTypeArgs = matchAccumulateSequence<TupleTypeArg, TupleTypeArg>(
        destTypeArgs.map(toSequenceItem),
        srcTypeArgs.map(toSequenceItem),
        matches,
        toStr,
        toStr,
        recursionCount
    );
    // if (!wasLocked) {
    //     constraints?.unlock();
    // }

    return matchedTypeArgs;
}

// A source type var tuple can match a type var tuple and/or zero or more singular types.
// E.g., consider the matching pair [V, *Vs] <==> [*Ds, D]:
// - *Vs and *Ds could match zero types and hence effectively V matches D but this is not a generic assignment as
//   we have completely ignored *Vs.
// - *Vs and *Ds each could match one type and hence effectively V matches *Ds and *Vs matches D but how is it possible
//   to assign *Ds to V, so this is not a valid assignment.
// - V matches the first type of *Ds: Ds[0],  and *Vs matches the rest of *Ds and D: *Ds[1:], D.
//   This way we have got a valid generic assignment of V and *Vs
// This function traverses matched sequence pairs allocating source type var tuples propely to
// matched destination types. If a singular dest type matches a type var tuple, it is assigned an element
// of that type var tuple. If a dest type var tuple matches a type var tuple, it is assigned what is left
// of that type var tuple. The function keeps track of how many times a source type var tuple is being
// assigned to singular dest types and reflects that subscripted source type var tuple.
function allocateSourceTypeVarTuples(matchedTypeArgs: DestItemMatches<TupleTypeArg, TupleTypeArg>[]) {
    interface IndexedVarAcc {
        index: number | undefined;
        total: number;
        isLast: boolean;
    }

    class IndexedVar {
        acc: IndexedVarAcc;
        offset: number;
        isExclusive: boolean;

        constructor(acc: IndexedVarAcc, offset: number, isExclusive: boolean) {
            this.acc = acc;
            this.offset = offset;
            this.isExclusive = isExclusive;
        }
        nextOffset() {
            this.acc.total += 1;
            return new IndexedVar(this.acc, this.offset + (this.isExclusive ? 0 : 1), /* isExclusive */ false);
        }
        nextIndexedVar() {
            return new IndexedVar(
                { index: this.acc.index === undefined ? 0 : this.acc.index + 1, total: 1, isLast: true },
                0,
                /* isExclusive */ true
            );
        }
        toTypeVarTupleIndexedVar(): TypeVarTulpeIndexedVar {
            return {
                index: this.acc.index,
                offset: this.offset,
                isExclusive: this.isExclusive,
                total: this.acc.total,
                isLastIndex: this.acc.isLast,
            };
        }
    }

    interface Subscript {
        kind: TypeVarTupleSubscriptKind;
        start: IndexedVar;
        end?: IndexedVar;
    }

    class TypeVarTupleIndexTracker {
        lastIndexedVar: IndexedVar = new IndexedVar({ index: undefined, total: 0, isLast: true }, -1, false);
        typeVarTuple: TypeVarTupleType;

        constructor(typeVarTuple: TypeVarTupleType) {
            this.typeVarTuple = typeVarTuple;
        }

        // draws and allocates an index from this type var tuple when it matches a singular type
        allocateIndex() {
            const start = this.lastIndexedVar.nextOffset();
            this.lastIndexedVar = start;
            return { kind: TypeVarTupleSubscriptKind.Index, start };
        }

        allocateSlice() {
            const start = this.lastIndexedVar.nextOffset();
            start.acc.isLast = false;
            const end = this.lastIndexedVar.nextIndexedVar();
            this.lastIndexedVar = end;
            return { kind: TypeVarTupleSubscriptKind.Slice, start, end };
        }

        // Returns the corresponding subscript given the allocated index. When no index
        // is provided, it is assumed as an allocated slice and hence it returns the
        // subscript corresponding to the allocated slice. There will be only one allocated
        // slice as a type var tuple cannot match more than one type var tuple.
        getSubscript(subscript: Subscript) {
            const start = subscript.start.toTypeVarTupleIndexedVar();
            const end = subscript.end?.toTypeVarTupleIndexedVar();

            if (
                subscript.kind === TypeVarTupleSubscriptKind.Slice &&
                start.index === undefined &&
                start.offset === 0 &&
                start.total === 1 &&
                !start.isLastIndex &&
                !!end &&
                end.index === 0 &&
                end.offset === 0 &&
                end.total === 1 &&
                end.isLastIndex
            ) {
                return undefined;
            }

            return {
                base: TypeBase.cloneType(this.typeVarTuple),
                kind: subscript.kind,
                start,
                end,
            };
        }
    }

    const srcTypeVarTupleTrackers = new Map<string, TypeVarTupleIndexTracker>();

    return (
        matchedTypeArgs
            // First pass, allocate indicies and slices from source type var tuples
            .map(({ destItem, matchedSrcItems }) => {
                const destArg = destItem.item;
                const mappedSrcSequence = matchedSrcItems.map((srcItem, i) => {
                    const srcArg = srcItem.item;
                    if (isTypeVarTuple(srcArg.type)) {
                        let tracker = srcTypeVarTupleTrackers.get(srcArg.type.shared.name);
                        if (!tracker) {
                            tracker = new TypeVarTupleIndexTracker(srcArg.type);
                            srcTypeVarTupleTrackers.set(srcArg.type.shared.name, tracker);
                        }
                        return {
                            srcArg,
                            typeVarTuple: srcArg.type,
                            subscript: isTypeVarTuple(destArg.type) ? tracker.allocateSlice() : tracker.allocateIndex(),
                        };
                    } else {
                        return { srcArg };
                    }
                });
                return { destArg, srcSequence: mappedSrcSequence };
            })
            // Second pass, convert allocated indicies and slices to concrete subscripted
            // type var tuples. The reason we need a second pass is that, if a source
            // type var tuple matches a type var tuple first, we don't know in advance
            // whether or not we should allocate a slice, and if so we don't know what slice
            // to allocate. This is because we don't know how many singular types it will match later.
            .map(({ destArg, srcSequence }) => {
                const mappedSrcSequence = srcSequence.map((srcArg) => {
                    if (srcArg.typeVarTuple) {
                        const tracker =
                            srcTypeVarTupleTrackers.get(srcArg.typeVarTuple.shared.name) ??
                            new TypeVarTupleIndexTracker(srcArg.typeVarTuple);
                        const subscript = tracker.getSubscript(srcArg.subscript);
                        const indexedTypeVarTuple = subscript
                            ? TypeVarType.cloneAsSubscripted(srcArg.typeVarTuple, subscript)
                            : TypeBase.cloneType(srcArg.typeVarTuple);
                        if (isTypeVarTuple(indexedTypeVarTuple)) {
                            indexedTypeVarTuple.priv.isUnpacked = true;
                        }
                        return {
                            ...srcArg.srcArg,
                            type: indexedTypeVarTuple,
                        };
                    } else {
                        return srcArg.srcArg;
                    }
                });
                return { destArg, srcSequence: mappedSrcSequence };
            })
    );
}

// Subscripted type var tuples are generated as a result of matching type var tuples
// to multiple singular types. We use this utility function to combine a contiguous
// sequence of subscripted type var tuples back into one type var tuple, the original
// type var tuple. This is to avoid confusion and further ambiguity when matching
// against subscripted type var tuples. If subscripted type var tuples becomes a thing
// in python specs, we need to distinguish between synthesized and normal cases.
function combineSubscriptedTypeVars(args: TupleTypeArg[]) {
    if (args.length === 0) {
        return args;
    }

    const isSubscriptOfTheSameTypeVar = (
        confirmedSubscript: TypeVarTupleSubscript,
        subjectSubscript: TypeVarTupleSubscript | undefined
    ): subjectSubscript is TypeVarTupleSubscript =>
        !!subjectSubscript && isTypeVarSame(confirmedSubscript.base, subjectSubscript.base);

    let prevSubscript: TypeVarTupleSubscript | undefined;
    let startIndex: number | undefined = undefined;
    let isUnbounded: boolean = false;
    let isOptional: boolean | undefined = undefined;
    let i = 0;
    while (i <= args.length) {
        const currentArg: TupleTypeArg | undefined = i < args.length ? args[i] : undefined;
        const currentSubscript =
            currentArg?.type && isTypeVar(currentArg.type) ? currentArg.type.priv.subscript : undefined;

        if (!!prevSubscript && isSubscriptOfTheSameTypeVar(prevSubscript, currentSubscript)) {
            // continue or break
            if (TypeVarTupleSubscript.areAdjacent(prevSubscript, currentSubscript)) {
                prevSubscript = currentSubscript;
            } else {
                startIndex = undefined;
                prevSubscript = undefined;
            }
            if (!!currentArg && isTypeVarTuple(currentSubscript.base)) {
                isUnbounded = currentArg.isUnbounded;
                isOptional = currentArg.isOptional;
            }
        } else if (
            startIndex !== undefined &&
            !!prevSubscript &&
            !isSubscriptOfTheSameTypeVar(prevSubscript, currentSubscript)
        ) {
            // end
            if (TypeVarTupleSubscript.isValidEnd(prevSubscript)) {
                const baseArg = {
                    type: prevSubscript.base,
                    isUnbounded,
                    isOptional,
                };
                args.splice(startIndex, i - startIndex, baseArg);
            }
            startIndex = undefined;
            prevSubscript = undefined;
        } else if (!!currentSubscript && !isSubscriptOfTheSameTypeVar(currentSubscript, prevSubscript)) {
            // start
            if (TypeVarTupleSubscript.isValidStart(currentSubscript)) {
                startIndex = i;
                prevSubscript = currentSubscript;
            }
            if (!!currentArg && isTypeVarTuple(currentSubscript.base)) {
                isUnbounded = currentArg.isUnbounded;
                isOptional = currentArg.isOptional;
            }
        }
        i++;
    }
    return args;
}

// Adjusts the source and/or dest type arguments list to attempt to match
// the length of the src type arguments list if the dest or source contain
// entries with indeterminate length or unpacked TypeVarTuple entries.
// It returns true if the source is potentially compatible with the dest
// type, false otherwise.
export function adjustTupleTypeArgs(
    evaluator: TypeEvaluator,
    destTypeArgs: TupleTypeArg[],
    srcTypeArgs: TupleTypeArg[],
    flags: AssignTypeFlags
): boolean {
    const destUnboundedOrVariadicIndex = destTypeArgs.findIndex((t) => t.isUnbounded || isTypeVarTuple(t.type));
    const srcUnboundedIndex = srcTypeArgs.findIndex((t) => t.isUnbounded);
    const srcVariadicIndex = srcTypeArgs.findIndex((t) => isTypeVarTuple(t.type));

    if (srcUnboundedIndex >= 0) {
        if (isAnyOrUnknown(srcTypeArgs[srcUnboundedIndex].type)) {
            // If the source contains an unbounded Any, expand it to match the dest length.
            const typeToReplicate = srcTypeArgs.length > 0 ? srcTypeArgs[srcUnboundedIndex].type : AnyType.create();

            while (srcTypeArgs.length < destTypeArgs.length) {
                srcTypeArgs.splice(srcUnboundedIndex, 0, { type: typeToReplicate, isUnbounded: true });
            }

            if (srcTypeArgs.length > destTypeArgs.length) {
                srcTypeArgs.splice(srcUnboundedIndex, 1);
            }
        } else if (destUnboundedOrVariadicIndex < 0) {
            // If the source contains an unbounded type but the dest does not, it's incompatible.
            return false;
        }
    }

    // If the dest contains an unbounded Any, expand it to match the source length.
    if (
        destUnboundedOrVariadicIndex >= 0 &&
        destTypeArgs[destUnboundedOrVariadicIndex].isUnbounded &&
        isAnyOrUnknown(destTypeArgs[destUnboundedOrVariadicIndex].type)
    ) {
        while (destTypeArgs.length < srcTypeArgs.length) {
            destTypeArgs.splice(destUnboundedOrVariadicIndex, 0, destTypeArgs[destUnboundedOrVariadicIndex]);
        }
    }

    // Remove any optional parameters from the end of the two lists until the lengths match.
    while (srcTypeArgs.length > destTypeArgs.length && srcTypeArgs[srcTypeArgs.length - 1].isOptional) {
        srcTypeArgs.splice(srcTypeArgs.length - 1, 1);
    }

    while (destTypeArgs.length > srcTypeArgs.length && destTypeArgs[destTypeArgs.length - 1].isOptional) {
        destTypeArgs.splice(destTypeArgs.length - 1, 1);
    }

    const srcArgsToCapture = srcTypeArgs.length - destTypeArgs.length + 1;
    let skipAdjustSrc = false;

    // If we're doing reverse type mappings and the source contains a TypeVarTuple,
    // we need to adjust the dest so the reverse type mapping assignment
    // can be performed.
    if ((flags & AssignTypeFlags.Contravariant) !== 0) {
        const destArgsToCapture = destTypeArgs.length - srcTypeArgs.length + 1;

        if (srcVariadicIndex >= 0 && destArgsToCapture >= 0) {
            // If the only removed arg from the dest type args is itself a variadic,
            // don't bother adjusting it.
            const skipAdjustment = destArgsToCapture === 1 && isTypeVarTuple(destTypeArgs[srcVariadicIndex].type);
            const tupleClass = evaluator.getTupleClassType();

            if (!skipAdjustment && tupleClass && isInstantiableClass(tupleClass)) {
                const removedArgs = destTypeArgs.splice(srcVariadicIndex, destArgsToCapture);

                // Package up the remaining type arguments into a tuple object.
                const variadicTuple = ClassType.cloneAsInstance(
                    specializeTupleClass(
                        tupleClass,
                        removedArgs.map((typeArg) => {
                            return {
                                type: typeArg.type,
                                isUnbounded: typeArg.isUnbounded,
                                isOptional: typeArg.isOptional,
                            };
                        }),
                        /* isTypeArgExplicit */ true,
                        /* isUnpacked */ true
                    )
                );

                destTypeArgs.splice(srcVariadicIndex, 0, {
                    type: variadicTuple,
                    isUnbounded: false,
                });
            }

            skipAdjustSrc = true;
        }
    } else {
        if (destUnboundedOrVariadicIndex >= 0 && srcArgsToCapture >= 0) {
            // If the dest contains a variadic element, determine which source
            // args map to this element and package them up into an unpacked tuple.
            if (isTypeVarTuple(destTypeArgs[destUnboundedOrVariadicIndex].type)) {
                const tupleClass = evaluator.getTupleClassType();

                if (tupleClass && isInstantiableClass(tupleClass)) {
                    const removedArgs = srcTypeArgs.splice(destUnboundedOrVariadicIndex, srcArgsToCapture);

                    let variadicTuple: Type;

                    // If we're left with a single unpacked variadic type var, there's no
                    // need to wrap it in a nested tuple.
                    if (removedArgs.length === 1 && isUnpackedTypeVarTuple(removedArgs[0].type)) {
                        variadicTuple = removedArgs[0].type;
                    } else {
                        // Package up the remaining type arguments into a tuple object.
                        variadicTuple = ClassType.cloneAsInstance(
                            specializeTupleClass(
                                tupleClass,
                                removedArgs.map((typeArg) => {
                                    return {
                                        type: typeArg.type,
                                        isUnbounded: typeArg.isUnbounded,
                                        isOptional: typeArg.isOptional,
                                    };
                                }),
                                /* isTypeArgExplicit */ true,
                                /* isUnpacked */ true
                            )
                        );
                    }

                    srcTypeArgs.splice(destUnboundedOrVariadicIndex, 0, {
                        type: variadicTuple,
                        isUnbounded: false,
                    });
                }

                skipAdjustSrc = true;
            }
        }
    }

    if (!skipAdjustSrc && destUnboundedOrVariadicIndex >= 0 && srcArgsToCapture >= 0) {
        // If possible, package up the source entries that correspond to
        // the dest unbounded tuple. This isn't possible if the source contains
        // an unbounded tuple outside of this range.
        if (
            srcUnboundedIndex < 0 ||
            (srcUnboundedIndex >= destUnboundedOrVariadicIndex &&
                srcUnboundedIndex < destUnboundedOrVariadicIndex + srcArgsToCapture)
        ) {
            const removedArgTypes = srcTypeArgs.splice(destUnboundedOrVariadicIndex, srcArgsToCapture).map((t) => {
                if (isTypeVar(t.type) && isUnpackedTypeVarTuple(t.type)) {
                    return TypeVarType.cloneForUnpacked(t.type, /* isInUnion */ true);
                }
                return t.type;
            });

            srcTypeArgs.splice(destUnboundedOrVariadicIndex, 0, {
                type: removedArgTypes.length > 0 ? combineTypes(removedArgTypes) : AnyType.create(),
                isUnbounded: false,
            });
        }
    }

    return destTypeArgs.length === srcTypeArgs.length;
}

// Given a tuple type and a slice expression, determines the resulting
// type if it can be determined. If not, it returns undefined.
export function getSlicedTupleType(
    evaluator: TypeEvaluator,
    tupleType: ClassType,
    sliceNode: SliceNode
): Type | undefined {
    // We don't handle step values.
    if (sliceNode.d.stepValue || !tupleType.priv.tupleTypeArgs) {
        return undefined;
    }

    const tupleTypeArgs = tupleType.priv.tupleTypeArgs;
    const startValue = getTupleSliceParam(evaluator, sliceNode.d.startValue, 0, tupleTypeArgs);
    const endValue = getTupleSliceParam(evaluator, sliceNode.d.endValue, tupleTypeArgs.length, tupleTypeArgs);

    if (startValue === undefined || endValue === undefined || endValue < startValue) {
        return undefined;
    }

    const slicedTypeArgs = tupleTypeArgs.slice(startValue, endValue);
    return ClassType.cloneAsInstance(specializeTupleClass(tupleType, slicedTypeArgs));
}

function getTupleSliceParam(
    evaluator: TypeEvaluator,
    expression: ExpressionNode | undefined,
    defaultValue: number,
    tupleTypeArgs: TupleTypeArg[]
): number | undefined {
    let value = defaultValue;

    if (expression) {
        const valType = evaluator.getTypeOfExpression(expression).type;
        if (!isClassInstance(valType) || !ClassType.isBuiltIn(valType, 'int') || !isLiteralType(valType)) {
            return undefined;
        }

        value = valType.priv.literalValue as number;
        const unboundedIndex = tupleTypeArgs.findIndex(
            (typeArg) => typeArg.isUnbounded || isTypeVarTuple(typeArg.type)
        );

        if (value < 0) {
            value = tupleTypeArgs.length + value;
            if (unboundedIndex >= 0 && value <= unboundedIndex) {
                return undefined;
            } else if (value < 0) {
                return 0;
            }
        } else {
            if (unboundedIndex >= 0 && value > unboundedIndex) {
                return undefined;
            } else if (value > tupleTypeArgs.length) {
                return tupleTypeArgs.length;
            }
        }
    }

    return value;
}
