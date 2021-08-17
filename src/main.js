const admin = require('firebase-admin')
const args = require('process').argv
const path = require('path')
const { Client } = require('pg')
const dotenv = require('dotenv')
const pgFormat = require('pg-format')
const { promises: fs } = require('fs')
const { firestoreTypes } = require('./firestore')
const { postgresTypes } = require('./postgres')

dotenv.config()

admin.initializeApp()
const db = admin.firestore()

let isDryRun = !args.includes('--go')
const isDebug = args.includes('--debug')
const outputCreateQueries = args.includes('--show-creates')
const outputFirstInsertQuery = args.includes('--show-first-insert')

const argNameOfCollectionsToProcess = args.find((arg) =>
  arg.includes('--collections')
)

let nameOfCollectionsToProcess = []

if (argNameOfCollectionsToProcess) {
  nameOfCollectionsToProcess = argNameOfCollectionsToProcess
    .split('--collections=')[1]
    .split(',')
}

const argLimit = args.find((arg) => arg.includes('--limit'))

let limit = null

if (argLimit) {
  limit = parseInt(argLimit.split('--limit=')[1])
}

let postgresClient
let schemas

async function loadSchemas() {
  const schemaJson = await fs.readFile(
    path.resolve(process.cwd(), './schema.json')
  )

  schemas = JSON.parse(schemaJson)
}

function getSchemas() {
  return schemas
}

async function connectToPostgres() {
  postgresClient = new Client(process.env.POSTGRESQL_CONNECTION_URL)
  await postgresClient.connect()
  return postgresClient
}

async function disconnectFromPostgres() {
  await postgresClient.end()
}

async function runSqlQuery(query, params = []) {
  if (isDryRun) {
    if (isDebug) console.debug(`Skipping query (dry run)`, query, params)
    return
  }

  if (isDebug) console.debug(query, params)

  return postgresClient.query(query, params)
}

const escape = (str) => pgFormat.literal(str)

const getFirestoreFieldNamesForTable = (tableName) => {
  const schema = getSchemaForCollection(tableName)
  return schema.map((fieldDef) => fieldDef.source)
}

const isFirebaseDate = (val) =>
  val && typeof val === 'object' && val.hasOwnProperty('_seconds')

const isFirebaseReference = (val) =>
  val && typeof val === 'object' && val.hasOwnProperty('_firestore')

const getFirestoreValueAsString = (val) => {
  if (typeof val === 'string') {
    return `${escape(val)}`
  }
  return "''"
}

const recursivelyReplaceFirestoreRefs = (thing) => {
  if (thing instanceof admin.firestore.DocumentReference) {
    return `${thing.parent.id}=${thing.id}`
  }

  if (Array.isArray(thing)) {
    return thing.map((child) => recursivelyReplaceFirestoreRefs(child))
  }

  if (thing && typeof thing === 'object') {
    const newObject = {}

    for (key in thing) {
      const originalValue = thing[key]

      newObject[key] = recursivelyReplaceFirestoreRefs(originalValue)
    }

    return newObject
  }

  return thing
}

const mapFieldToInsertStatement = (tableName, fieldName, fieldValue) => {
  const schema = getSchemaForCollection(tableName)
  const fieldDef = schema.find((item) => item.source === fieldName)

  if (Array.isArray(fieldDef.colType)) {
    const fieldItems = Array.isArray(fieldValue) ? fieldValue : []

    switch (fieldDef.colType[1]) {
      case postgresTypes.TEXT:
        return `ARRAY[${fieldItems
          .map((val) => escape(val))
          .join(', ')}]::TEXT[]`
      case postgresTypes.JSONB:
        return `ARRAY[${fieldItems
          .map((val) =>
            escape(JSON.stringify(recursivelyReplaceFirestoreRefs(val)))
          )
          .join(', ')}]::JSONB[]`
    }
  }

  switch (fieldDef.colType) {
    case postgresTypes.TEXT:
      return getFirestoreValueAsString(fieldValue)
    case postgresTypes.TIMESTAMP:
      if (isFirebaseDate(fieldValue)) {
        return `to_timestamp(${fieldValue.seconds})`
      } else {
        return 'null'
      }
    case postgresTypes.BOOL:
      if (fieldValue === true) {
        return "'true'"
      }
      if (fieldValue === false) {
        return "'false'"
      }
      return 'null'
    case postgresTypes.JSONB:
      if (
        fieldValue &&
        typeof fieldValue === 'object' &&
        !isFirebaseReference(fieldValue) &&
        !isFirebaseDate(fieldValue)
      ) {
        return `${escape(
          JSON.stringify(recursivelyReplaceFirestoreRefs(fieldValue))
        )}`
      }
      return 'null'
  }

  if (fieldDef.fieldType && Array.isArray(fieldDef.fieldType)) {
    if (fieldDef.fieldType[0] === firestoreTypes.REF) {
      // NOTE: 2nd item could be "ANY" as Firestore can reference ANY collection
      // Either store as $COLLECTIONNAME=$ID or
      // Split into 2 columns $COLNAME_$COLLECTIONNAME and $COLNAME_$ID
      if (isFirebaseReference(fieldValue)) {
        return `'${fieldValue.id}'`
      } else {
        return 'null'
      }
    } else if (Array.isArray(fieldDef.fieldType[1])) {
      if (fieldDef.fieldType[1][0] === firestoreTypes.REF) {
        if (Array.isArray(fieldValue)) {
          return `ARRAY[${fieldValue
            .map((ref) => `'${ref.id}'`)
            .join(', ')}]::TEXT[]`
        } else {
          return 'ARRAY[]::TEXT[]'
        }
      }
    }
  }

  throw new Error(
    `Cannot map field for insert statement: name=${fieldName} colType=${fieldDef.colType}`
  )
}

const getSchemaForCollection = (collectionName) => {
  const schemas = getSchemas()
  if (schemas[collectionName]) {
    return schemas[collectionName]
  }
  throw new Error(
    `Cannot get schema for collection "${collectionName}" - not defined!`
  )
}

const getColumnNamesForTable = (tableName) => {
  const schema = getSchemaForCollection(tableName)

  return schema.map((fieldDef) => fieldDef.dest || fieldDef.source)
}

const getPostgresFieldInfoFromSchemaField = (fieldDef) => {
  let fieldInfo = ''

  const postgresColumnName = fieldDef.dest || fieldDef.source

  // TODO: Do not assume field is defined perfect - validate at start or end?

  fieldInfo += postgresColumnName

  if (fieldDef.colType) {
    if (Array.isArray(fieldDef.colType)) {
      switch (fieldDef.colType[0]) {
        case postgresTypes.ARRAY:
          // TODO: This does not support nested arrays!
          fieldInfo += ` ${fieldDef.colType[1]}[]`
          break
      }
    } else {
      fieldInfo += ` ${fieldDef.colType}`
    }
  }

  if (fieldDef.fieldType) {
    switch (fieldDef.fieldType[0]) {
      case firestoreTypes.REF:
        fieldInfo += ` TEXT`
        break
      case firestoreTypes.ARRAY:
        if (
          Array.isArray(fieldDef.fieldType[1]) &&
          fieldDef.fieldType[1][0] === firestoreTypes.REF
        ) {
          fieldInfo += ` TEXT[]`
        }
        break
    }

    //     fieldInfo += `,
    // CONSTRAINT fk_${postgresColumnName}
    //   FOREIGN KEY(${postgresColumnName})
    //     REFERENCES ${fieldDef.type[1]}(id)`
  }

  // always do at end!
  if (fieldDef.settings) {
    fieldInfo += ` ${fieldDef.settings.join(' ')}`
  }

  return fieldInfo
}

async function createTableIfNoExist(tableName) {
  const schema = getSchemaForCollection(tableName)

  if (isDebug)
    console.debug(`Creating table "${tableName}" (if it does not exist)...`)

  const query = `CREATE TABLE IF NOT EXISTS ${tableName} (
    id TEXT PRIMARY KEY,
    ${schema
      .map((fieldDef) => getPostgresFieldInfoFromSchemaField(fieldDef))
      .join(',\n')}
  )`

  if (outputCreateQueries) console.debug(query)

  await runSqlQuery(query)
}

async function insertFirebaseDocsIntoTable(collectionName, docs) {
  // TODO: Let user map collection name to a new table name?
  const tableName = collectionName

  if (isDebug)
    console.debug(`Inserting ${docs.length} into table "${tableName}"...`)

  // improves speed of insert
  await runSqlQuery(`ALTER TABLE ${tableName} SET UNLOGGED`)

  // will prevent supabase insert/update/etc. triggers which is good
  await runSqlQuery(`ALTER TABLE ${tableName} DISABLE TRIGGER ALL`)

  const startOfInsertQuery = `INSERT INTO ${tableName} (id, ${getColumnNamesForTable(
    tableName
  ).join(', ')})
  VALUES`

  if (outputFirstInsertQuery) console.debug(startOfInsertQuery)

  await runSqlQuery(`${startOfInsertQuery}
  ${docs
    .map((doc, idx) => {
      const valuesStr = `('${doc.id}', 
        ${getFirestoreFieldNamesForTable(tableName)
          .map((fieldName) => {
            const fieldValue = doc.get(fieldName)
            return mapFieldToInsertStatement(tableName, fieldName, fieldValue)
          })
          .join(', ')})`

      if (outputFirstInsertQuery && idx === 0) {
        console.debug(valuesStr)
      }

      return valuesStr
    })
    .join(',\n')}`)

  await runSqlQuery(`ALTER TABLE ${tableName} SET LOGGED`)

  await runSqlQuery(`ALTER TABLE ${tableName} ENABLE TRIGGER ALL`)
}

function getCollectionNames() {
  return Object.keys(getSchemas())
}

async function getDocsInCollection(collectionName) {
  let query = db.collection(collectionName)

  if (limit) {
    console.info(`Only fetching ${limit} docs`)
    query = query.limit(limit)
  }

  const { docs } = await query.get()
  return docs
}

async function migrateCollectionToSupabase(collectionName) {
  console.info(`Migrating collection "${collectionName}"...`)

  await createTableIfNoExist(collectionName)

  const docs = await getDocsInCollection(collectionName)

  console.info(`Found ${docs.length} docs in collection`)

  await insertFirebaseDocsIntoTable(collectionName, docs)

  console.info(`Collection has been migrated successfully`)
}

async function main() {
  const processedCollectionNames = []
  let collectionNamesToProcess = []

  try {
    if (isDryRun) {
      console.log(
        'This is a dry run - no data will be inserted. Pass --go to skip the dry run!'
      )
    }

    console.log('Starting...')

    await loadSchemas()

    await connectToPostgres()

    const allCollectionNames = getCollectionNames()

    console.log(
      `Found ${
        allCollectionNames.length
      } collections: ${allCollectionNames.join(', ')}`
    )

    if (nameOfCollectionsToProcess.length) {
      console.log(
        `Only processing these collections: ${nameOfCollectionsToProcess.join(
          ', '
        )}`
      )
    }

    collectionNamesToProcess = nameOfCollectionsToProcess.length
      ? nameOfCollectionsToProcess
      : allCollectionNames

    for (const collectionName of collectionNamesToProcess) {
      await migrateCollectionToSupabase(collectionName)
      processedCollectionNames.push(collectionName)
    }

    await disconnectFromPostgres()

    console.log('Job done')
  } catch (err) {
    const remainingCollectionNames = collectionNamesToProcess.filter(
      (name) => !processedCollectionNames.includes(name)
    )
    console.error('Failed to convert Firestore to Supabase:', err)
    console.error(
      `These collection names were processed: ${processedCollectionNames.join(
        ', '
      )}`
    )
    console.error(
      `These collection names still need to be processed: ${remainingCollectionNames.join(
        ', '
      )}`
    )
    console.error(
      `You can only process those collections by passing --collections=${remainingCollectionNames.join(
        ','
      )} (ensure those collections do NOT have a table created)`
    )
    process.exit(1)
  }
}

main()
