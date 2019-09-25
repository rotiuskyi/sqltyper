#!/usr/bin/env node
// tslint:disable:no-console
import { promises as fs } from 'fs'
import watch from 'node-watch'
import * as path from 'path'

import camelCase = require('camelcase')
import * as Array from 'fp-ts/lib/Array'
import * as Either from 'fp-ts/lib/Either'
import * as Option from 'fp-ts/lib/Option'
import * as Ord from 'fp-ts/lib/Ord'
import * as Ordering from 'fp-ts/lib/Ordering'
import * as Task from 'fp-ts/lib/Task'
import * as TaskEither from 'fp-ts/lib/TaskEither'
import { pipe } from 'fp-ts/lib/pipeable'
import * as yargs from 'yargs'

import { Clients, connect, disconnect } from './clients'
import { sqlToTS, indexModuleTS, TsModule, TsModuleDir } from './index'
import { traverseATs } from './fp-utils'
import { identity } from 'fp-ts/lib/function'

type Options = {
  verbose: boolean
  index: boolean
  prettify: boolean
  pgModule: string
}

async function main(): Promise<number> {
  const args = parseArgs()
  if (!args._.length) {
    console.error('No input files. Try with `--help`.')
    return 1
  }

  const options: Options = {
    verbose: args.verbose,
    index: args.index,
    prettify: args.prettify,
    pgModule: args['pg-module'],
  }

  const dirPaths: string[] = []
  for (const dirPath of args._) {
    if (!(await fs.stat(dirPath)).isDirectory()) {
      console.error(`Not a directory: ${dirPath}`)
      return 1
    }
    dirPaths.push(dirPath)
  }
  const fileExtensions = extensions(args.ext)

  const clients = await connect(args.database)
  if (Either.isLeft(clients)) {
    console.error(clients.left)
    throw process.exit(1)
  }

  if (args.watch) {
    await watchDirectories(clients.right, fileExtensions, dirPaths, options)
  } else {
    await processDirectories(clients.right, fileExtensions, dirPaths, options)()
  }

  await disconnect(clients.right)
  return 0
}

function parseArgs() {
  return yargs
    .usage('Usage: $0 [options] DIRECTORY...')
    .option('database', {
      alias: 'd',
      describe:
        'Database URI to connect to, e.g. -d postgres://user:pass@localhost/mydb. ' +
        'If not given, relies node-postgres default connecting logic which uses ' +
        'environment variables',
      type: 'string',
    })
    .option('ext', {
      alias: 'e',
      describe: 'File extensions to consider, e.g. -e sql,psql',
      type: 'string',
      default: 'sql',
    })
    .option('verbose', {
      alias: 'v',
      describe:
        'Give verbose output about problems with inferring statement nullability.',
      type: 'boolean',
      default: false,
    })
    .option('index', {
      describe:
        'Generate an index.ts file that re-exports all generated functions',
      type: 'boolean',
      default: true,
    })
    .option('watch', {
      alias: 'w',
      description: 'Watch files and run the conversion when something changes',
      type: 'boolean',
      default: false,
    })
    .option('prettify', {
      alias: 'p',
      description: 'Apply prettier to output TypeScript files',
      type: 'boolean',
      default: false,
    })
    .option('pg-module', {
      description: 'Where to import node-postgres from.',
      type: 'string',
      default: 'pg',
    })
    .epilogue(
      `\
Generate TypeScript functions for SQL statements in all files in the \
given directories. For each input file, the output file name is \
generated by removing the file extension and appending ".ts".

Each output file will export a single function whose name is a \
camelCased version of the basename of the input file.

$0 connects to the database to infer the parameter and output column \
types of each SQL statement. It does this without actually executing \
the SQL queries, so it's safe to run against any database.
`
    )
    .help().argv
}

type WatchEvent = {
  type: 'update' | 'remove'
  dirPath: string
  fileName: string
}

type WatchEventHandler = (
  modules: TsModule[],
  type: 'update' | 'remove',
  dirPath: string,
  fileName: string
) => Promise<TsModule[]>

async function watchDirectories(
  clients: Clients,
  fileExtensions: string[],
  dirPaths: string[],
  options: Options
): Promise<void> {
  let moduleDirs = await processDirectories(
    clients,
    fileExtensions,
    dirPaths,
    options
  )()

  const eventBuffer: WatchEvent[] = []
  let handlingEvents = false
  const eventHandler = makeWatchEventHandler(clients, options)

  dirPaths.forEach(dirPath =>
    watch(
      dirPath,
      { filter: fileName => hasOneOfExtensions(fileExtensions, fileName) },
      async (event: 'update' | 'remove', filePath: string) => {
        eventBuffer.push({
          type: event,
          dirPath,
          fileName: path.relative(dirPath, filePath),
        })
        if (!handlingEvents) {
          handlingEvents = true
          moduleDirs = await handleWatchEvents(
            moduleDirs,
            eventBuffer,
            eventHandler
          )
          handlingEvents = false
        }
      }
    )
  )

  return new Promise(() => {})
}

async function handleWatchEvents(
  moduleDirs: TsModuleDir[],
  events: WatchEvent[],
  eventHandler: WatchEventHandler
): Promise<TsModuleDir[]> {
  while (events.length > 0) {
    const { type, dirPath, fileName } = events.shift()!

    const moduleDir = moduleDirs.find(dir => dir.dirPath === dirPath)
    if (moduleDir == null) return moduleDirs

    const newModules = await eventHandler(
      moduleDir.modules,
      type,
      dirPath,
      fileName
    )
    moduleDirs = pipe(
      modifyWhere(
        moduleDir => moduleDir.dirPath === dirPath,
        moduleDir => ({ dirPath: moduleDir.dirPath, modules: newModules }),
        moduleDirs
      ),
      Option.getOrElse(() => moduleDirs)
    )
  }
  return moduleDirs
}

function makeWatchEventHandler(
  clients: Clients,
  options: Options
): WatchEventHandler {
  return async (
    tsModules: TsModule[],
    type: 'update' | 'remove',
    dirPath: string,
    sqlFileName: string
  ) => {
    const sqlFilePath = path.join(dirPath, sqlFileName)

    let result: Task.Task<TsModule[]>
    switch (type) {
      case 'update':
        result = pipe(
          processSQLFile(clients, sqlFilePath, options),
          Task.map(tsModuleOption =>
            pipe(
              tsModuleOption,
              Option.map(tsModule => replaceOrAddTsModule(tsModule, tsModules)),
              Option.getOrElse(() => tsModules)
            )
          )
        )
        break
      case 'remove':
        await removeOutputFile(sqlFilePath)
        result = pipe(Task.of(removeTsModule(sqlFileName, tsModules)))
        break

      default:
        throw new Error('never reached')
    }

    result = pipe(
      result,
      Task.chain(newModules =>
        maybeWriteIndexModule(
          options.index,
          dirPath,
          newModules,
          options.prettify
        )
      )
    )

    return await result()
  }
}

function replaceOrAddTsModule(
  tsModule: TsModule,
  tsModules: TsModule[]
): TsModule[] {
  return pipe(
    modifyWhere(
      mod => mod.sqlFileName === tsModule.sqlFileName,
      () => tsModule,
      tsModules
    ),
    Option.getOrElse((): TsModule[] => Array.snoc(tsModules, tsModule))
  )
}

function modifyWhere<A>(
  pred: (value: A) => boolean,
  replacer: (found: A) => A,
  where: A[]
): Option.Option<A[]> {
  return pipe(
    where.findIndex(pred),
    Option.fromNullable,
    Option.chain(index =>
      pipe(
        where,
        Array.modifyAt(index, () => replacer(where[index]))
      )
    )
  )
}

function removeTsModule(
  sqlFileName: string,
  tsModules: TsModule[]
): TsModule[] {
  return tsModules.filter(mod => mod.sqlFileName != sqlFileName)
}

function processDirectories(
  clients: Clients,
  fileExtensions: string[],
  dirPaths: string[],
  options: Options
): Task.Task<TsModuleDir[]> {
  return traverseATs(dirPaths, dirPath =>
    processDirectory(clients, dirPath, fileExtensions, options)
  )
}

function processDirectory(
  clients: Clients,
  dirPath: string,
  fileExtensions: string[],
  options: Options
): Task.Task<TsModuleDir> {
  return pipe(
    findSQLFilePaths(dirPath, fileExtensions),
    Task.chain(filePaths =>
      pipe(
        traverseATs(filePaths, filePath =>
          processSQLFile(clients, filePath, options)
        ),
        Task.map(Array.filterMap(identity))
      )
    ),
    Task.chain(modules =>
      maybeWriteIndexModule(options.index, dirPath, modules, options.prettify)
    ),
    Task.map(modules => ({ dirPath, modules }))
  )
}

function processSQLFile(
  clients: Clients,
  filePath: string,
  options: Options
): Task.Task<Option.Option<TsModule>> {
  const tsPath = getOutputPath(filePath)
  const fnName = funcName(filePath)
  console.log('---------------------------------------------------------')
  console.log(`${filePath} => ${tsPath}`)

  return pipe(
    Task.of(fs.readFile(filePath)),
    Task.map(s => s.toString()),
    Task.chain(source =>
      sqlToTS(clients, source, fnName, {
        prettierFileName: options.prettify ? tsPath : undefined,
        pgModule: options.pgModule,
        verbose: options.verbose,
      })
    ),
    TaskEither.chain(tsCode => () =>
      fs.writeFile(tsPath, tsCode).then(Either.right)
    ),
    TaskEither.mapLeft(errorMessage => {
      console.error(errorMessage)
    }),
    TaskEither.map(() => ({
      sqlFileName: path.basename(filePath),
      tsFileName: path.basename(tsPath),
      funcName: fnName,
    })),
    Task.map(Option.fromEither)
  )
}

function maybeWriteIndexModule(
  write: boolean,
  dirPath: string,
  tsModules: TsModule[],
  prettify: boolean
): Task.Task<TsModule[]> {
  const tsPath = path.join(dirPath, 'index.ts')

  if (write) {
    return pipe(
      Task.of(tsModules),
      Task.map(modules =>
        pipe(
          modules,
          Array.sort(
            Ord.fromCompare((a: TsModule, b: TsModule) =>
              Ordering.sign(a.tsFileName.localeCompare(b.tsFileName))
            )
          )
        )
      ),
      Task.chain(sortedModules =>
        indexModuleTS(sortedModules, {
          prettierFileName: prettify ? tsPath : null,
        })
      ),
      Task.chain(tsCode => () => fs.writeFile(tsPath, tsCode)),
      Task.map(() => tsModules)
    )
  }
  return Task.of(tsModules)
}

function funcName(filePath: string) {
  const parsed = path.parse(filePath)
  return camelCase(parsed.name)
}

async function removeOutputFile(filePath: string): Promise<void> {
  const tsPath = getOutputPath(filePath)
  try {
    await fs.unlink(tsPath)
  } catch (_err) {
    return
  }
  console.log('---------------------------------------------------------')
  console.log(`Removed ${tsPath}`)
}

function findSQLFilePaths(
  dirPath: string,
  fileExtensions: string[]
): Task.Task<string[]> {
  return pipe(
    () =>
      fs.readdir(dirPath, {
        encoding: 'utf-8',
        withFileTypes: true,
      }),
    Task.chain(dirents =>
      pipe(
        traverseATs(dirents, dirent =>
          pipe(
            isSQLFile(fileExtensions, dirPath, dirent.name),
            Task.map(is => (is ? Option.some(dirent) : Option.none))
          )
        ),
        Task.map(Array.filterMap(identity)),
        Task.map(dirents =>
          dirents.map(dirent => path.join(dirPath, dirent.name))
        )
      )
    )
  )
}

function getOutputPath(filePath: string): string {
  return path.format({
    ...path.parse(filePath),
    base: undefined,
    ext: '.ts',
  })
}

function extensions(e: string): string[] {
  return e.split(',').map(ext => `.${ext}`)
}

function isSQLFile(
  extensions: string[],
  dirPath: string,
  fileName: string
): Task.Task<boolean> {
  return async () => {
    let stats
    try {
      stats = await fs.stat(path.join(dirPath, fileName))
    } catch (_err) {
      return false
    }
    return stats.isFile() && hasOneOfExtensions(extensions, fileName)
  }
}

function hasOneOfExtensions(exts: string[], fileName: string): boolean {
  return exts.includes(path.parse(fileName).ext)
}

main()
  .then(status => process.exit(status))
  .catch(err => {
    console.error(err)
    process.exit(99)
  })
