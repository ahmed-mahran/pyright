import { assert, fail } from '../common/debug';
import { DiagnosticAddendum } from '../common/diagnostic';
import { ExpressionNode } from '../parser/parseNodes';
import { ConstraintTracker } from './constraintTracker';
import { EvalFlags, TypeEvaluator, TypeResult } from './typeEvaluatorTypes';
import {
    ClassType,
    combineTypes,
    isClass,
    isInstantiableClass,
    isTypeSame,
    isTypeVar,
    isTypeVarTuple,
    isUnknown,
    TupleTypeArg,
    Type,
    TypeBase,
    TypeFlags,
    TypeVarType,
    UnknownType,
} from './types';
import { InferenceContext, isTupleClass, mapSubtypes, specializeTupleClass } from './typeUtils';

export namespace MyPyrightExtensions {
    const enum TupleCreationFlags {
        None = 0,

        TypeArgsExplicit = 1 << 0,

        Unpacked = 1 << 1,

        Map = 1 << 2,
    }

    function createTupleTypeInstance(
        evaluator: TypeEvaluator,
        tupleTypeArgs: TupleTypeArg[],
        flags = TupleCreationFlags.None
    ) {
        const tupleClass = evaluator.getTupleClassType();
        if (tupleClass && isInstantiableClass(tupleClass)) {
            const instantiableClass = tupleClass;
            const isTypeArgsExplicit: boolean | undefined =
                (flags & TupleCreationFlags.TypeArgsExplicit) !== 0 ? true : undefined;
            const isUnpacked: boolean | undefined = (flags & TupleCreationFlags.Unpacked) !== 0 ? true : undefined;
            const isMap: boolean | undefined = (flags & TupleCreationFlags.Map) !== 0 ? true : undefined;
            const tuple = specializeTupleClass(instantiableClass, tupleTypeArgs, isTypeArgsExplicit, isUnpacked);
            tuple.priv.isMapTuple = isMap;
            return tuple;
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
        typeResult: TypeResult,
        node: ExpressionNode,
        flags = EvalFlags.None,
        constraints: ConstraintTracker | undefined,
        inferenceContext?: InferenceContext
    ) {
        let returnType: Type = typeResult.type;
        if (returnType && isClass(returnType) && returnType.shared.moduleName === 'mypyright_extensions') {
            console.debug(`Handling ${returnType.shared.fullName}`);
            const diag = function () {
                if (!typeResult.expectedTypeDiagAddendum) {
                    typeResult.expectedTypeDiagAddendum = new DiagnosticAddendum();
                }
                typeResult.expectedTypeDiagAddendum.addTextRange(node);
                typeResult.typeErrors = true;
                return typeResult.expectedTypeDiagAddendum;
            };

            switch (returnType.shared.name) {
                case 'Map':
                    returnType = handleMap(evaluator, returnType, flags, diag);
                    break;
            }
        }

        typeResult.type = returnType;
        return typeResult;
    }

    // Map[type, int, T, *Ts]  ==== tuple[type[int], type[T], *Ts: type]
    // Map[type, int]  ==== tuple[type[int]]
    // Map[type, T]  ==== tuple[type[T]]
    // Map[type, *Ts]  ==== tuple[*Ts: type]
    function handleMap(
        evaluator: TypeEvaluator,
        type: ClassType,
        flags = EvalFlags.None,
        diag: () => DiagnosticAddendum
    ): Type {
        function setProperFlags<T extends Type>(type: T): T {
            if ((flags & EvalFlags.InstantiableType) !== 0) {
                type.flags |= TypeFlags.Instantiable;
                type.flags &= ~TypeFlags.Instance;
            } else {
                type.flags |= TypeFlags.Instance;
                type.flags &= ~TypeFlags.Instantiable;
            }
            return type;
        }

        if (type.priv.typeArgs) {
            let rawMap = type.priv.typeArgs[0];
            // Strip all map tuples to properly support nested Maps
            // Map[Map[F1, Map[F2, ...]], ...] ==> Map[F1[F2[...]], ...]
            while (
                isClass(rawMap) &&
                !!rawMap.priv.isMapTuple &&
                rawMap.priv.tupleTypeArgs &&
                rawMap.priv.tupleTypeArgs.length === 1
            ) {
                rawMap = rawMap.priv.tupleTypeArgs[0].type;
            }
            const map = MapType.fromMappedType(evaluator, setFlagMapped(rawMap));
            if (map) {
                const mapArg = type.priv.typeArgs[1];
                if (isTypeVarTuple(mapArg) && !!mapArg.priv.isUnpacked) {
                    return setProperFlags(
                        setFlagMapped(
                            createTupleTypeInstance(
                                evaluator,
                                [{ type: convertToMappedType(map, mapArg), isUnbounded: false }],
                                TupleCreationFlags.Map
                            )
                        )
                    );
                    // return convertToMappedType(map, mapArg);
                } else if (isClass(mapArg) && isTupleClass(mapArg)) {
                    // mapArg.priv.isMapTuple = true;
                    // mapArg.priv.isUnpacked &&= false;
                    // return convertToMappedType(map, mapArg);
                    return setProperFlags(
                        setFlagMapped(
                            createTupleTypeInstance(
                                evaluator,
                                (convertToMappedType(map, mapArg) as ClassType).priv.tupleTypeArgs ?? [],
                                TupleCreationFlags.Map
                            )
                        )
                    );
                }
            } else {
                diag().addMessage(`Cannot create a Map from ${evaluator.printType(type)}`);
            }
        }
        return type;
    }

    export function convertToMappedType(map: MapType, type?: Type): Type {
        //TODO if type is Union, return map of Union or Union of maps?
        // Now we return map of Union because it is simplier and doesn't
        // seem to be wrong.

        if (type && isTypeVarTuple(type)) {
            type.shared.mappedBoundType = convertToMappedType(
                map,
                // for nesting; the base case is to start by boundType when
                // mappedBoundType is firstly undefined then go for mappedBoundType
                type.shared.mappedBoundType ?? type.shared.boundType
            );
            return setFlagMapped(TypeBase.cloneType(type));
        } else if (type && isClass(type) && isTupleClass(type) && isIterTuple(type)) {
            const clone = TypeBase.cloneType(type);
            clone.priv.tupleTypeArgs = type.priv.tupleTypeArgs?.map((arg) => ({
                type: convertToMappedType(map, arg.type),
                isUnbounded: arg.isUnbounded,
                isOptional: arg.isOptional,
            }));
            return setFlagMapped(clone);
        } else {
            return setFlagMapped(map.specialize(type));
        }
    }

    export class MapType {
        outer: Type;
        inner?: MapType;

        constructor(outer: Type, inner?: MapType) {
            this.outer = outer;
            this.inner = inner;
        }

        get type(): Type {
            return MapType.mapToType(this);
        }

        specialize(arg?: Type): Type {
            return MapType.specialize(this, arg);
        }
    }

    export namespace MapType {
        export function fromMappedType(evaluator: TypeEvaluator, type: Type): MapType | undefined {
            assert(isMappedType(type), `Type ${evaluator.printType(type)} is not a mapped type!`);

            function _from(type: Type): MapType | undefined {
                if (!isMappedType(type)) {
                    return undefined;
                }

                if (TypeBase.isInstantiable(type) && !TypeBase.isInstance(type)) {
                    return new MapType(
                        getTypeClassType(evaluator),
                        _from(TypeBase.cloneTypeAsInstance(type, /* cache */ false))
                    );
                } else if (isClass(type) && isEffectivelyGenericClassType(type)) {
                    const mapArg = firstOptional(type.priv.tupleTypeArgs)?.type ?? firstOptional(type.priv.typeArgs);
                    const innerMap = mapArg ? _from(mapArg) : undefined;
                    return new MapType(specializeMapClassType(type), innerMap);
                }

                return undefined;
            }

            return _from(type);
        }

        export function mapToType(map: MapType): Type {
            return map.inner ? specializeMapType(map.outer, mapToType(map.inner)) : map.outer;
        }

        export function specialize(map: MapType, arg?: Type): Type {
            return specializeMapType(map.outer, map.inner ? specialize(map.inner, arg) : arg);
        }

        export function combine(maps: MapType[]): MapType | undefined {
            const inners = maps.map((map) => map.inner).filter((inner) => inner !== undefined);
            if (inners.length !== maps.length && inners.length > 0) {
                inners.push(new MapType(newUnknownType()));
            }

            return new MapType(
                combineTypes(maps.map((map) => map.outer)),
                inners.length > 0 ? combine(inners) : undefined
            );
        }
    }

    export interface MapSpec {
        map: MapType;
        arg: Type;
    }

    interface InternalMapSpec {
        map?: MapType;
        arg: Type;
    }

    export function deconstructMappedType1(evaluator: TypeEvaluator, type: Type): MapSpec {
        assert(isMappedType(type), `Type ${evaluator.printType(type)} is not a mapped type!`);

        function _deconstructMappedType(type: Type): InternalMapSpec {
            //TODO do union of maps?

            if (isMappedType(type)) {
                if (TypeBase.isInstantiable(type) && !TypeBase.isInstance(type)) {
                    const { map, arg } = _deconstructMappedType(TypeBase.cloneTypeAsInstance(type, /* cache */ false));
                    return { map: new MapType(getTypeClassType(evaluator), map), arg };
                } else if (isClass(type) && isEffectivelyGenericClassType(type)) {
                    if (isTupleClass(type) && isIterTuple(type)) {
                        const deconstructions =
                            type.priv.tupleTypeArgs?.map((a) => {
                                const { map, arg } = _deconstructMappedType(a.type);
                                return {
                                    map,
                                    arg,
                                    isUnbounded: a.isUnbounded,
                                    isOptional: a.isOptional,
                                };
                            }) ?? [];
                        const concreteMaps = deconstructions.map((d) => d.map).filter((m) => !!m);
                        const map = MapType.combine(concreteMaps);
                        const arg = unsetFlagMapped(
                            ClassType.cloneAsInstance(
                                specializeTupleClass(
                                    type,
                                    deconstructions.map((a) => ({
                                        type: a.arg,
                                        isUnbounded: a.isUnbounded,
                                        isOptional: a.isOptional,
                                    }))
                                )
                            )
                        );
                        arg.priv.isEmptyContainer = deconstructions.length === 0;
                        return { map: map ?? new MapType(newUnknownType()), arg };
                    }

                    const firstArg = firstOptional(type.priv.tupleTypeArgs)?.type ?? firstOptional(type.priv.typeArgs);
                    const { map, arg } = _deconstructMappedType(
                        firstArg ? TypeBase.cloneType(firstArg) : newUnknownType()
                    );
                    return { map: new MapType(specializeMapType(type), map), arg };
                } else if (isTypeVar(type) && type.shared.mappedBoundType) {
                    //TODO handle constraints maybe?
                    const clone = unsetFlagMapped(TypeBase.cloneType(type));
                    const { map, arg } = _deconstructMappedType(type.shared.mappedBoundType);
                    clone.shared.boundType = arg;
                    return { map, arg: clone };
                } else {
                    return {
                        map: new MapType(specializeMapType(type)),
                        arg: newUnknownType(),
                    };
                }
            } else {
                return {
                    arg: TypeBase.cloneType(type),
                };
            }
        }

        const internalMapSpec = _deconstructMappedType(type);
        assert(!!internalMapSpec.map, `Cannot get a map for type ${evaluator.printType(type)}!`);
        return { map: internalMapSpec.map, arg: internalMapSpec.arg };
    }

    export function deconstructMappedType2(
        evaluator: TypeEvaluator,
        type: Type,
        baseMap: MapType,
        isTypeDest: boolean
    ): MapSpec | undefined {
        function _deconstructMappedType2(type: Type, baseMap?: MapType): InternalMapSpec | undefined {
            //TODO do union of maps?

            if (baseMap) {
                if (
                    TypeBase.isInstantiable(type) &&
                    !TypeBase.isInstance(type) &&
                    isClass(baseMap.outer) &&
                    ClassType.isBuiltIn(baseMap.outer, 'type')
                ) {
                    const innerMapSpec = _deconstructMappedType2(
                        TypeBase.cloneTypeAsInstance(type, /* cache */ false),
                        baseMap.inner
                    );
                    return innerMapSpec
                        ? { map: new MapType(getTypeClassType(evaluator), innerMapSpec.map), arg: innerMapSpec.arg }
                        : undefined;
                } else if (isClass(type) && isEffectivelyGenericClassType(type)) {
                    if (
                        isTupleClass(type) &&
                        (!isClass(baseMap.outer) ||
                            !isTupleClass(baseMap.outer) ||
                            baseMap.outer.priv.tupleTypeArgs?.length !== type.priv.tupleTypeArgs?.length ||
                            (baseMap.outer.priv.tupleTypeArgs ?? []).find(
                                (arg, i) => i > 0 && !isTypeSame(arg.type, (type.priv.tupleTypeArgs ?? [])[i].type)
                            ) !== undefined)
                    ) {
                        const deconstructions =
                            type.priv.tupleTypeArgs?.map((a) => {
                                const deconstruction = _deconstructMappedType2(a.type, baseMap);
                                if (deconstruction) {
                                    return {
                                        deconstruction: deconstruction,
                                        isUnbounded: a.isUnbounded,
                                        isOptional: a.isOptional,
                                    };
                                } else {
                                    return undefined;
                                }
                            }) ?? [];
                        const concreteDeconstructions: {
                            deconstruction: InternalMapSpec;
                            isUnbounded: boolean;
                            isOptional?: boolean;
                        }[] = [];
                        const concreteMaps: MapType[] = [];
                        deconstructions.forEach((d) => {
                            if (d !== undefined && !!d.deconstruction.map) {
                                concreteDeconstructions.push(d);
                                concreteMaps.push(d.deconstruction.map);
                            }
                        });
                        if (deconstructions.length !== concreteMaps.length) {
                            return undefined;
                        }
                        const map = MapType.combine(concreteMaps);
                        const arg = unsetFlagMapped(
                            ClassType.cloneAsInstance(
                                specializeTupleClass(
                                    type,
                                    concreteDeconstructions.map((a) => ({
                                        type: a.deconstruction.arg,
                                        isUnbounded: a.isUnbounded,
                                        isOptional: a.isOptional,
                                    }))
                                )
                            )
                        );
                        arg.priv.isEmptyContainer = deconstructions.length === 0;
                        return map ? { map, arg } : undefined;
                    } else if (
                        isClass(baseMap.outer) &&
                        (isTypeDest
                            ? ClassType.isDerivedFrom(baseMap.outer, type)
                            : ClassType.isDerivedFrom(type, baseMap.outer))
                    ) {
                        const arg = firstOptional(type.priv.tupleTypeArgs)?.type ?? firstOptional(type.priv.typeArgs);
                        const innerMapSpec = _deconstructMappedType2(
                            arg ? TypeBase.cloneType(arg) : newUnknownType(),
                            baseMap.inner
                        );
                        return innerMapSpec
                            ? { map: new MapType(specializeMapType(type), innerMapSpec.map), arg: innerMapSpec.arg }
                            : undefined;
                    }
                } else if (isTypeVar(type)) {
                    //TODO handle constraints maybe?

                    const clone = unsetFlagMapped(TypeBase.cloneType(type));
                    if (type.shared.mappedBoundType) {
                        const innerMapSpec = _deconstructMappedType2(type.shared.mappedBoundType, baseMap);
                        if (innerMapSpec) {
                            clone.shared.boundType = innerMapSpec.arg;
                        }
                        return innerMapSpec ? { map: innerMapSpec.map, arg: clone } : undefined;
                    } else {
                        const innerMapSpec = _deconstructMappedType2(clone, baseMap.inner);
                        return innerMapSpec
                            ? { map: new MapType(baseMap.outer, innerMapSpec.map), arg: innerMapSpec.arg }
                            : undefined;
                    }
                }
            } else {
                return { arg: unsetFlagMapped(type) };
            }
            return undefined;
        }

        const internalMapSpec = _deconstructMappedType2(type, baseMap);
        return internalMapSpec && internalMapSpec.map
            ? { map: internalMapSpec.map, arg: internalMapSpec.arg }
            : undefined;
    }

    export function deconstructMutualMappedTypes(
        evaluator: TypeEvaluator,
        destType: Type,
        srcType: Type
    ): { destMapSpec: MapSpec; srcMapSpec: MapSpec } | undefined {
        if (isMappedType(destType)) {
            const destMapSpec = deconstructMappedType1(evaluator, destType);
            const srcMapSpec = deconstructMappedType2(evaluator, srcType, destMapSpec.map, /*isTypeDest*/ false);
            return srcMapSpec ? { destMapSpec, srcMapSpec } : undefined;
        } else if (isMappedType(srcType)) {
            const srcMapSpec = deconstructMappedType1(evaluator, srcType);
            const destMapSpec = deconstructMappedType2(evaluator, destType, srcMapSpec.map, /*isTypeDest*/ true);
            return destMapSpec ? { destMapSpec, srcMapSpec } : undefined;
        }

        // should not happen
        fail('Either type should be mapped or a base map should be provided!');
    }

    export function isMappedType(type: Type): boolean {
        return (type.flags & TypeFlags.Mapped) !== 0;
    }

    export function setFlagMapped<T extends Type>(type: T): T {
        if (!isUnknown(type)) {
            type.flags |= TypeFlags.Mapped;
        }
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
        function replaceFirst<T>(ts: T[] | undefined, clone: (t: T) => T, replace: (t: T | undefined) => T): T[] {
            return ts && ts.length > 0 ? ts.map((t, i) => (i === 0 ? replace(t) : clone(t))) : [replace(undefined)];
        }

        let mapped;
        if (ClassType.isBuiltIn(map, 'tuple')) {
            mapped = specializeTupleClass(
                map,
                replaceFirst(
                    map.priv.tupleTypeArgs,
                    (a) => ({
                        type: TypeBase.cloneType(a.type),
                        isUnbounded: a?.isUnbounded ?? false,
                        isOptional: a?.isOptional,
                    }),
                    (a) => ({
                        type: type ?? newUnknownType(),
                        isUnbounded: a?.isUnbounded ?? false,
                        isOptional: a?.isOptional,
                    })
                )
            );
            mapped.priv.isUnpacked &&= !!map.priv.tupleTypeArgs && map.priv.tupleTypeArgs.length > 0;
        } else {
            mapped = ClassType.specialize(
                map,
                replaceFirst(map.priv.typeArgs, TypeBase.cloneType, (_) => type ?? newUnknownType()),
                undefined,
                undefined
            );
        }
        return ClassType.cloneAsInstance(mapped);
    }

    export function specializeMapType(map: Type, type?: Type): Type {
        return mapSubtypes(map, (subtypeOfMap) => {
            if (isClass(subtypeOfMap) && isEffectivelyGenericClassType(subtypeOfMap)) {
                return specializeMapClassType(
                    subtypeOfMap,
                    // A nested map is mapped and specialized with map argument
                    // If one is found, we need to specialize it with argument `type`
                    // and then specialize our `map` with the result
                    // isMappedType(subtypeOfMap) && subtypeOfMap.priv.typeArgs ? specializeMapType(subtypeOfMap.priv.typeArgs[0], type) : type
                    type ? TypeBase.cloneType(type) : undefined
                );
            } else {
                return TypeBase.cloneType(subtypeOfMap);
            }
        });
    }

    function isIterTuple(type: ClassType) {
        return !!type.priv.isMapTuple || !!type.priv.isUnpacked;
    }

    export function printTypeVar(evaluator: TypeEvaluator, type: TypeVarType) {
        return `${evaluator.printType(type)}${printTypeVarBound(evaluator, type)}`;
    }

    export function printTypeVarBound(evaluator: TypeEvaluator, type: TypeVarType) {
        const boundType = isMappedType(type) ? type.shared.mappedBoundType : type.shared.boundType;
        return boundType ? `: ${evaluator.printType(boundType)}` : '';
    }

    export function firstOptional<T>(ts: T[] | undefined): T | undefined {
        return ts?.find((_, i) => i === 0);
    }

    function newUnknownType() {
        // return TypeBase.cloneType(UnknownType.create());
        return UnknownType.create();
    }
}
