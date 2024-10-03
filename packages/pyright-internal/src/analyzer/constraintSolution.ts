/*
 * constraintSolution.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Data structure that holds one or more constraint solutions for a set
 * of type variables.
 */

import { assert } from '../common/debug';
import { combineTypes, FunctionType, ParamSpecType, Type, TypeVarType } from './types';

// Records the types associated with a set of type variables.
export class ConstraintSolutionSet {
    // Indexed by TypeVar ID.
    private _typeVarMap: Map<string, Type | undefined>;

    constructor() {
        this._typeVarMap = new Map();
    }

    isEmpty() {
        return this._typeVarMap.size === 0;
    }

    getType(typeVar: ParamSpecType): FunctionType | undefined;
    getType(typeVar: TypeVarType): Type | undefined;
    getType(typeVar: TypeVarType): Type | undefined {
        const key = TypeVarType.getKey(typeVar);
        return this._typeVarMap.get(key);
    }

    setType(typeVar: TypeVarType, type: Type | undefined) {
        const key = TypeVarType.getKey(typeVar);
        return this._typeVarMap.set(key, type);
    }

    hasType(typeVar: TypeVarType): boolean {
        const key = TypeVarType.getKey(typeVar);
        return this._typeVarMap.has(key);
    }

    doForEachTypeVar(callback: (type: Type, typeVarId: string) => void) {
        this._typeVarMap.forEach((type, key) => {
            if (type) {
                callback(type, key);
            }
        });
    }

    static combine(allSets: ConstraintSolutionSet[]): ConstraintSolutionSet | undefined {
        if (allSets.length > 1) {
            const result = new ConstraintSolutionSet();
            const allKeys: Set<string> = new Set();
            allSets.forEach((set) => {
                for (const key of set._typeVarMap.keys()) {
                    allKeys.add(key);
                }
            });
            for (const key of allKeys) {
                const types: Type[] = [];
                allSets.forEach((set) => {
                    const type = set._typeVarMap.get(key);
                    if (type) {
                        types.push(type);
                    }
                });
                result._typeVarMap.set(key, types.length > 0 ? combineTypes(types) : undefined);
            }
            return result;
        } else if (allSets.length === 1) {
            return allSets[0];
        } else {
            return undefined;
        }
    }
}

export class ConstraintSolution {
    private _solutionSets: ConstraintSolutionSet[];

    constructor(solutionSets?: ConstraintSolutionSet[]) {
        this._solutionSets =
            solutionSets && solutionSets.length > 0 ? [...solutionSets] : [new ConstraintSolutionSet()];
    }

    isEmpty() {
        return this._solutionSets.every((set) => set.isEmpty());
    }

    setType(typeVar: TypeVarType, type: Type) {
        return this._solutionSets.forEach((set) => {
            set.setType(typeVar, type);
        });
    }

    getMainSolutionSet() {
        return this.getSolutionSet(0);
    }

    getSolutionSets() {
        return this._solutionSets;
    }

    doForEachSolutionSet(callback: (solutionSet: ConstraintSolutionSet, index: number) => void) {
        this.getSolutionSets().forEach((set, index) => {
            callback(set, index);
        });
    }

    getSolutionSet(index: number) {
        assert(index >= 0 && index < this._solutionSets.length);
        return this._solutionSets[index];
    }

    static combine(allSolutions: ConstraintSolution[]): ConstraintSolution | undefined {
        if (allSolutions.length > 1) {
            const firstSolutions = allSolutions[0]._solutionSets;
            assert(
                allSolutions.every((constraints) => constraints._solutionSets.length === firstSolutions.length),
                'All solutions must have the same number of sets'
            );
            const result = new ConstraintSolution();
            result._solutionSets = [];
            for (let i = 0; i < firstSolutions.length; i++) {
                const combinedSet = ConstraintSolutionSet.combine(
                    allSolutions.map((constraints) => constraints._solutionSets[i])
                );
                if (combinedSet) {
                    result._solutionSets.push(combinedSet);
                }
            }
            return result;
        } else if (allSolutions.length === 1) {
            return allSolutions[0];
        } else {
            return undefined;
        }
    }
}
