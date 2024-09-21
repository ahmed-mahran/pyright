/*
 * constraintTracker.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Module that tracks the constraints for a set of type variables.
 * It is used by the constraint solver to solve for the type of
 * each type variable.
 */

import { assert } from '../common/debug';
import { MyPyrightExtensions } from './mypyrightExtensionsUtils';
import { getComplexityScoreForType } from './typeComplexity';
import { TypeEvaluator } from './typeEvaluatorTypes';
import { Type, TypeVarScopeId, TypeVarType, combineTypes, isTypeSame } from './types';

// The maximum number of constraint sets that can be associated
// with a constraint tracker. This equates to the number of overloads
// that can be captured by a ParamSpec (or multiple ParamSpecs).
// We should never hit this limit in practice, but there are certain
// pathological cases where we could, and we need to protect against
// this so it doesn't completely exhaust memory. This was previously
// set to 64, but we have seen cases where a library uses in excess
// of 300 overloads on a single function.
const maxConstraintSetCount = 1024;

// Records constraint information about a single type variable.
export interface TypeVarConstraints {
    typeVar: TypeVarType;

    // Bounds for solved type variable as constraints are added.
    lowerBound?: Type | undefined;
    upperBound?: Type | undefined;

    // Should the lower bound include literal values?
    retainLiterals?: boolean;
}

// Records the constraints information for a set of type variables
// associated with a callee's signature.
export class ConstraintSet {
    // Maps type variable IDs to their current constraints.
    private _typeVarMap: Map<string, TypeVarConstraints>;

    // A set of one or more TypeVar scope IDs that identify this constraint set.
    // This corresponds to the scope ID of the overload signature. Normally
    // there will be only one scope ID associated with each signature, but
    // we can have multiple if we are solving for multiple ParamSpecs. If
    // there are two ParamSpecs P1 and P2 and both are bound to 3 overloads,
    // we'll have 9 sets of TypeVars that we're solving, for all combinations
    // of P1 and P2).
    private _scopeIds: Set<string> | undefined;

    constructor() {
        this._typeVarMap = new Map<string, TypeVarConstraints>();
    }

    clone() {
        const constraintSet = new ConstraintSet();

        this._typeVarMap.forEach((value) => {
            constraintSet.setBounds(value.typeVar, value.lowerBound, value.upperBound, value.retainLiterals);
        });

        if (this._scopeIds) {
            this._scopeIds.forEach((scopeId) => constraintSet.addScopeId(scopeId));
        }

        return constraintSet;
    }

    isSame(other: ConstraintSet) {
        if (this._typeVarMap.size !== other._typeVarMap.size) {
            return false;
        }

        function typesMatch(type1: Type | undefined, type2: Type | undefined) {
            if (!type1 || !type2) {
                return type1 === type2;
            }

            return isTypeSame(type1, type2);
        }

        let isSame = true;
        this._typeVarMap.forEach((value, key) => {
            const otherValue = other._typeVarMap.get(key);
            if (
                !otherValue ||
                !typesMatch(value.lowerBound, otherValue.lowerBound) ||
                !typesMatch(value.upperBound, otherValue.upperBound)
            ) {
                isSame = false;
            }
        });

        return isSame;
    }

    isEmpty() {
        return this._typeVarMap.size === 0;
    }

    // Provides a "score" - a value that values completeness (number
    // of type variables that are assigned) and simplicity.
    getScore() {
        let score = 0;

        // Sum the scores for the defined type vars.
        this._typeVarMap.forEach((entry) => {
            // Add 1 to the score for each type variable defined.
            score += 1;

            // Add a fractional amount based on the simplicity of the definition.
            // The more complex, the lower the score. In the spirit of Occam's
            // Razor, we always want to favor simple answers.
            const typeVarType = entry.lowerBound ?? entry.upperBound;
            if (typeVarType) {
                score += 1.0 - getComplexityScoreForType(typeVarType);
            }
        });

        return score;
    }

    setBounds(typeVar: TypeVarType, lowerBound: Type | undefined, upperBound?: Type, retainLiterals?: boolean) {
        const key = TypeVarType.getKey(typeVar);
        this._typeVarMap.set(key, {
            typeVar,
            lowerBound,
            upperBound,
            retainLiterals,
        });
    }

    doForEachTypeVar(cb: (entry: TypeVarConstraints) => void) {
        this._typeVarMap.forEach(cb);
    }

    getTypeVar(typeVar: TypeVarType): TypeVarConstraints | undefined {
        const key = TypeVarType.getKey(typeVar);
        return this._typeVarMap.get(key);
    }

    getTypeVars(): TypeVarConstraints[] {
        const entries: TypeVarConstraints[] = [];

        this._typeVarMap.forEach((entry) => {
            entries.push(entry);
        });

        return entries;
    }

    addScopeId(scopeId: TypeVarScopeId) {
        if (!this._scopeIds) {
            this._scopeIds = new Set<string>();
        }

        this._scopeIds.add(scopeId);
    }

    hasScopeId(scopeId: TypeVarScopeId) {
        if (!this._scopeIds) {
            return false;
        }

        return this._scopeIds.has(scopeId);
    }

    getScopeIds() {
        return new Set(this._scopeIds);
    }

    hasUnificationVars() {
        for (const entry of this._typeVarMap.values()) {
            if (TypeVarType.isUnification(entry.typeVar)) {
                return true;
            }
        }

        return false;
    }

    static combine(allSets: ConstraintSet[]): ConstraintSet | undefined {
        if (allSets.length > 1) {
            const result = new ConstraintSet();
            const allKeys: Set<string> = new Set();
            allSets.forEach((set) => {
                for (const key of set._typeVarMap.keys()) {
                    allKeys.add(key);
                }
                set._scopeIds?.forEach(result.addScopeId);
            });
            for (const key of allKeys) {
                let typeVar: TypeVarType | undefined = undefined;
                const lowerBounds: Type[] = [];
                const upperBounds: Type[] = [];
                let retainLiterals: boolean | undefined = undefined;
                allSets.forEach((set) => {
                    const typeVarConstraint = set._typeVarMap.get(key);
                    if (typeVarConstraint) {
                        typeVar = typeVarConstraint.typeVar;
                        if (typeVarConstraint.lowerBound) {
                            lowerBounds.push(typeVarConstraint.lowerBound);
                        }
                        if (typeVarConstraint.upperBound) {
                            upperBounds.push(typeVarConstraint.upperBound);
                        }
                        if (typeVarConstraint.retainLiterals !== undefined) {
                            retainLiterals ||= typeVarConstraint.retainLiterals;
                        }
                    }
                });
                if (typeVar) {
                    result.setBounds(
                        typeVar,
                        lowerBounds.length > 0 ? combineTypes(lowerBounds) : undefined,
                        upperBounds.length > 0 ? combineTypes(upperBounds) : undefined,
                        retainLiterals
                    );
                }
            }
            return result;
        } else if (allSets.length === 0) {
            return allSets[0];
        } else {
            return undefined;
        }
    }
}

export class ConstraintTracker {
    private _isLocked = false;
    private _constraintSets: ConstraintSet[];

    constructor(private _evaluator: TypeEvaluator) {
        this._constraintSets = [new ConstraintSet()];
    }

    clone() {
        const newTypeVarMap = new ConstraintTracker(this._evaluator);

        newTypeVarMap._constraintSets = this._constraintSets.map((set) => set.clone());
        newTypeVarMap._isLocked = this._isLocked;

        return newTypeVarMap;
    }

    cloneWithSignature(scopeId: TypeVarScopeId): ConstraintTracker {
        const cloned = this.clone();

        if (scopeId) {
            const filteredSets = this._constraintSets.filter((context) => context.hasScopeId(scopeId));

            if (filteredSets.length > 0) {
                cloned._constraintSets = filteredSets;
            } else {
                cloned._constraintSets.forEach((context) => {
                    context.addScopeId(scopeId);
                });
            }
        }

        return cloned;
    }

    // Copies a cloned type var context back into this object.
    copyFromClone(clone: ConstraintTracker) {
        this._constraintSets = clone._constraintSets.map((context) => context.clone());
        this._isLocked = clone._isLocked;
    }

    copyBounds(entry: TypeVarConstraints) {
        this._constraintSets.forEach((set) => {
            set.setBounds(entry.typeVar, entry.lowerBound, entry.upperBound, entry.retainLiterals);
        });
    }

    // Copy the specified constraint sets into this type var context.
    addConstraintSets(contexts: ConstraintSet[]) {
        assert(contexts.length > 0);

        // Limit the number of constraint sets. There are rare circumstances
        // where this can grow to unbounded numbers and exhaust memory.
        if (contexts.length < maxConstraintSetCount) {
            this._constraintSets = Array.from(contexts);
        }
    }

    isSame(other: ConstraintTracker) {
        if (other._constraintSets.length !== this._constraintSets.length) {
            return false;
        }

        return this._constraintSets.every((set, index) => set.isSame(other._constraintSets[index]));
    }

    lock() {
        // Locks the type var map, preventing any further changes.
        assert(!this._isLocked);
        this._isLocked = true;
    }

    unlock() {
        // Unlocks the type var map, allowing further changes.
        this._isLocked = false;
    }

    isLocked(): boolean {
        return this._isLocked;
    }

    isEmpty() {
        return this._constraintSets.every((set) => set.isEmpty());
    }

    setBounds(typeVar: TypeVarType, lowerBound: Type | undefined, upperBound?: Type, retainLiterals?: boolean) {
        // assert(!this._isLocked);
        if (!this._isLocked) {
            const adjustedLowerBound = MyPyrightExtensions.createBoundForTypeVar(this._evaluator, typeVar, lowerBound);
            const adjustedUpperBound = MyPyrightExtensions.createBoundForTypeVar(this._evaluator, typeVar, upperBound);
            return this._constraintSets.forEach((set) => {
                set.setBounds(typeVar, adjustedLowerBound, adjustedUpperBound, retainLiterals);
            });
        }
    }

    getScore() {
        let total = 0;

        this._constraintSets.forEach((set) => {
            total += set.getScore();
        });

        // Return the average score among all constraint sets.
        return total / this._constraintSets.length;
    }

    getMainConstraintSet() {
        return this._constraintSets[0];
    }

    getConstraintSets() {
        return this._constraintSets;
    }

    doForEachConstraintSet(callback: (constraintSet: ConstraintSet, index: number) => void) {
        const wasLocked = this.isLocked();
        this.unlock();

        this.getConstraintSets().forEach((set, index) => {
            callback(set, index);
        });

        if (wasLocked) {
            this.lock();
        }
    }

    getConstraintSet(index: number) {
        assert(index >= 0 && index < this._constraintSets.length);
        return this._constraintSets[index];
    }

    addCombinedConstraints(allConstraints: ConstraintTracker[]) {
        const combinedConstraints = ConstraintTracker.combine(allConstraints);
        const constraintSets = combinedConstraints?._constraintSets ?? [];
        if (constraintSets.length > 0) {
            this.addConstraintSets(combinedConstraints?._constraintSets ?? []);
        }
    }

    static combine(allConstraints: ConstraintTracker[]): ConstraintTracker | undefined {
        if (allConstraints.length > 1) {
            const firstConstraints = allConstraints[0]._constraintSets;
            assert(
                allConstraints.every((constraints) => constraints._constraintSets.length === firstConstraints.length),
                'All constraints must have the same number of sets'
            );
            const result = new ConstraintTracker(allConstraints[0]._evaluator);
            for (let i = 0; i < firstConstraints.length; i++) {
                const combinedSet = ConstraintSet.combine(
                    allConstraints.map((constraints) => constraints._constraintSets[i])
                );
                if (combinedSet) {
                    result._constraintSets.push(combinedSet);
                }
            }
            result._isLocked = allConstraints.some((constraints) => constraints._isLocked);
            return result;
        } else if (allConstraints.length === 0) {
            return allConstraints[0];
        } else {
            return undefined;
        }
    }
}
