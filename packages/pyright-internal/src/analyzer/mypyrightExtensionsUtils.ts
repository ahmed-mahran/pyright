import { fail } from '../common/debug';
import { ExpressionNode } from '../parser/parseNodes';
import { ConstraintTracker } from './constraintTracker';
import { EvalFlags, TypeEvaluator } from './typeEvaluatorTypes';
import {
    ClassType,
    combineTypes,
    isClass,
    isInstantiableClass,
    isTypeSame,
    isTypeVar,
    isTypeVarTuple,
    TupleTypeArg,
    Type,
    TypeBase,
    TypeFlags,
    TypeVarType,
    UnknownType,
} from './types';
import { InferenceContext, isTupleClass, specializeTupleClass } from './typeUtils';

export namespace MyPyrightExtensions {
    function createTupleTypeInstance(
        evaluator: TypeEvaluator,
        tupleTypeArgs: TupleTypeArg[],
        isTypeArgsExplicit: boolean | undefined = true,
        isUnpacked: boolean | undefined = false
    ) {
        const tupleClass = evaluator.getTupleClassType();
        if (tupleClass && isInstantiableClass(tupleClass)) {
            const instantiableClass = tupleClass;
            return ClassType.cloneAsInstance(
                specializeTupleClass(instantiableClass, tupleTypeArgs, isTypeArgsExplicit, isUnpacked)
            );
        }

        fail("Couldn't get a tuple class type from evaluator");
    }

    function getTypeClassType(evaluator: TypeEvaluator) {
        const typeClass = evaluator.getTypeClassType();
        if (typeClass) {
            return ClassType.cloneAsInstance(typeClass);
        }

        fail("Couldn't get a tuple class type from evaluator");
    }

    export function handleTypeForGetTypeOfExpression(
        evaluator: TypeEvaluator,
        type: Type,
        node: ExpressionNode,
        flags = EvalFlags.None,
        constraints: ConstraintTracker | undefined,
        inferenceContext?: InferenceContext
    ) {
        let returnType: Type = type;
        if (returnType && isClass(returnType) && returnType.shared.moduleName === 'mypyright_extensions') {
            console.debug(`Handling ${returnType.shared.fullName}`);
            // const diag = function (msg: string) {
            //     const diag = new DiagnosticAddendum();
            //     diag.addMessage(msg);
            //     diag.addTextRange(node);
            // };

            switch (returnType.shared.name) {
                case 'Map':
                    returnType = handleMap(evaluator, returnType);
                    break;
            }
        }

        return returnType;
    }

    // Map[type, int, T, *Ts]  ==== tuple[type[int], type[T], *Ts: type]
    // Map[type, int]  ==== type[int]
    // Map[type, T]  ==== type[T]
    // Map[type, *Ts]  ==== tuple[*Ts: type, ...]
    // ; e.g. for __getitem__(self, items), items can be a single item or a
    // packed tuple of items in case of more than one item, this is why
    // we convert Map[type, *Ts] to a tuple (tuple[*Ts: type, ...]) instead
    // of (*Ts: type)
    function handleMap(evaluator: TypeEvaluator, type: ClassType): Type {
        if (type.priv.typeArgs) {
            const map = type.priv.typeArgs[0];
            const mapArg = type.priv.typeArgs[1];
            if (isTypeVarTuple(mapArg) && !!mapArg.priv.isUnpacked) {
                return convertToMappedType(map, mapArg);
            } else if (isClass(mapArg) && isTupleClass(mapArg) && mapArg.priv.tupleTypeArgs) {
                const newArgs = mapArg.priv.tupleTypeArgs.map((arg) => {
                    return {
                        type: convertToMappedType(map, arg.type),
                        isUnbounded: arg.isUnbounded,
                        isOptional: arg.isOptional,
                    };
                });
                return createTupleTypeInstance(evaluator, newArgs);
            }
        }
        return type;
    }

    export function isMappedType(type: Type): boolean {
        return (type.flags & TypeFlags.Mapped) !== 0;
    }

    export function setFlagMapped<T extends Type>(type: T): T {
        type.flags |= TypeFlags.Mapped;
        return type;
    }

    export function unsetFlagMapped<T extends Type>(type: T): T {
        type.flags &= ~TypeFlags.Mapped;
        return type;
    }

    // Can be a Map type, i.e. first argument to Map[,]?
    export function isEffectivelyGenericClassType(type: ClassType): boolean {
        return (
            ClassType.isBuiltIn(type, 'type') ||
            type.shared.typeParams.length > 0 ||
            // ClassType.isPseudoGenericClass(type) ||
            (!!type.priv.typeArgs && type.priv.typeArgs.length > 0)
        );
    }

    export function specializeMapClassType(map: ClassType, type?: Type): ClassType {
        function replaceFirst<T>(ts: T[] | undefined, replace: (t: T | undefined) => T): T[] {
            return ts && ts.length > 0 ? ts.map((t, i) => (i === 0 ? replace(t) : t)) : [replace(undefined)];
        }

        let mapped;
        if (ClassType.isBuiltIn(map, 'tuple')) {
            mapped = specializeTupleClass(
                map,
                replaceFirst(map.priv.tupleTypeArgs, (a) => ({
                    type: type ?? UnknownType.create(),
                    isUnbounded: a?.isUnbounded ?? false,
                    isOptional: a?.isOptional,
                }))
            );
            mapped.priv.isUnpacked &&= !!map.priv.tupleTypeArgs && map.priv.tupleTypeArgs.length > 0;
        } else {
            mapped = ClassType.specialize(
                map,
                replaceFirst(map.priv.typeArgs, (_) => type ?? UnknownType.create()),
                undefined,
                undefined
            );
        }
        return ClassType.cloneAsInstance(mapped);
    }

    export function specializeMapType(map: Type, type?: Type): Type {
        return isClass(map) && isEffectivelyGenericClassType(map)
            ? specializeMapClassType(map, type)
            : TypeBase.cloneType(map);
    }

    export function convertToMappedType(map: Type, type?: Type): Type {
        function _convertToMappedType(map: Type, type?: Type): Type {
            //TODO if type is Union, return map of Union or Union of maps?
            // Now we return map of Union because it is simplier and doesn't
            // seem to be wrong.
            if (type && isTypeVarTuple(type)) {
                type.shared.boundType = type.shared.mappedBoundType = _convertToMappedType(map, type.shared.boundType);
                return type;
            } else {
                return specializeMapType(map, type);
            }
        }
        return setFlagMapped(_convertToMappedType(map, type));
    }

    export interface MapSpec {
        map: Type;
        arg: Type;
    }

    export function deconstructMappedType(evaluator: TypeEvaluator, type: Type, baseMap?: Type): MapSpec {
        //TODO do union of maps?

        if (
            TypeBase.isInstantiable(type) &&
            !TypeBase.isInstance(type) &&
            (!baseMap || (isClass(baseMap) && ClassType.isBuiltIn(baseMap, 'type')))
        ) {
            return {
                map: getTypeClassType(evaluator),
                arg: unsetFlagMapped(TypeBase.cloneTypeAsInstance(type, /* cache */ false)),
            };
        } else if (isClass(type) && isEffectivelyGenericClassType(type)) {
            if (isTupleClass(type)) {
                if (
                    !(!!baseMap || type.priv.isUnpacked) ||
                    (!!baseMap &&
                        isClass(baseMap) &&
                        isTupleClass(baseMap) &&
                        baseMap.priv.tupleTypeArgs?.length === type.priv.tupleTypeArgs?.length &&
                        (baseMap.priv.tupleTypeArgs ?? []).find(
                            (arg, i) => i > 0 && !isTypeSame(arg.type, (type.priv.tupleTypeArgs ?? [])[i].type)
                        ) !== undefined)
                ) {
                    return {
                        map: unsetFlagMapped(specializeMapType(type)),
                        arg:
                            type.priv.tupleTypeArgs && type.priv.tupleTypeArgs.length > 0
                                ? TypeBase.cloneType(type.priv.tupleTypeArgs[0].type)
                                : UnknownType.create(),
                    };
                } else {
                    const deconstructions =
                        type.priv.tupleTypeArgs?.map((a) => {
                            const { map, arg } = deconstructMappedType(evaluator, a.type, baseMap);
                            return {
                                map,
                                arg,
                                isUnbounded: a.isUnbounded,
                                isOptional: a.isOptional,
                            };
                        }) ?? [];
                    const map = unsetFlagMapped(combineTypes(deconstructions?.map((a) => a.map)));
                    const arg = ClassType.cloneAsInstance(
                        specializeTupleClass(
                            type,
                            deconstructions.map((a) => ({
                                type: a.arg,
                                isUnbounded: a.isUnbounded,
                                isOptional: a.isOptional,
                            }))
                        )
                    );
                    arg.priv.isEmptyContainer = deconstructions.length === 0;
                    return { map, arg };
                }
            }
            return {
                map: unsetFlagMapped(specializeMapType(type)),
                arg:
                    type.priv.typeArgs && type.priv.typeArgs.length > 0
                        ? TypeBase.cloneType(type.priv.typeArgs[0])
                        : UnknownType.create(),
            };
        } else if (isTypeVar(type)) {
            //TODO handle constraints maybe?

            const clone = unsetFlagMapped(TypeBase.cloneType(type));
            if (type.shared.mappedBoundType) {
                const { map, arg } = deconstructMappedType(evaluator, type.shared.mappedBoundType, baseMap);
                clone.shared.boundType = arg;
                return { map, arg: clone };
            } else {
                return { map: UnknownType.create(), arg: clone };
            }
        } else if (isMappedType(type)) {
            return {
                map: unsetFlagMapped(specializeMapType(type)),
                arg: UnknownType.create(),
            };
        } else {
            return {
                map: UnknownType.create(),
                arg: unsetFlagMapped(TypeBase.cloneType(type)),
            };
        }
    }

    export function deconstructMutualMappedTypes(
        evaluator: TypeEvaluator,
        type1: Type,
        type2: Type
    ): { mapSpec1: MapSpec; mapSpec2: MapSpec } {
        if (isMappedType(type1)) {
            const mapSpec1 = deconstructMappedType(evaluator, type1);
            const mapSpec2 = deconstructMappedType(evaluator, type2, mapSpec1.map);
            return { mapSpec1, mapSpec2 };
        } else if (isMappedType(type2)) {
            const mapSpec2 = deconstructMappedType(evaluator, type2);
            const mapSpec1 = deconstructMappedType(evaluator, type1, mapSpec2.map);
            return { mapSpec1, mapSpec2 };
        }

        // should not happen
        fail('Either type should be mapped or a base map should be provided!');
    }

    export function printTypeVar(evaluator: TypeEvaluator, type: TypeVarType) {
        return `${evaluator.printType(type)}${printTypeVarBound(evaluator, type)}`;
    }

    export function printTypeVarBound(evaluator: TypeEvaluator, type: TypeVarType) {
        const boundType = isMappedType(type) ? type.shared.mappedBoundType : type.shared.boundType;
        return boundType ? `: ${evaluator.printType(boundType)}` : '';
    }
}
