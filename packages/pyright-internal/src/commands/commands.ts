/*
 * commands.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Command identifier strings.
 */

export const enum Commands {
    createTypeStub = 'mypyright.createtypestub',
    restartServer = 'mypyright.restartserver',
    orderImports = 'mypyright.organizeimports',
    unusedImport = 'mypyright.unusedImport',
    dumpFileDebugInfo = 'mypyright.dumpFileDebugInfo',
    dumpTokens = 'mypyright.dumpTokens',
    dumpNodes = 'mypyright.dumpNodes',
    dumpTypes = 'mypyright.dumpTypes',
    dumpCachedTypes = 'mypyright.dumpCachedTypes',
    dumpCodeFlowGraph = 'mypyright.dumpCodeFlowGraph',
}
