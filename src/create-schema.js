const path = require('path')
const { promises: fs } = require('fs')

async function main() {
    try {
        console.info('Creating schema...')
        const pathToSchemaCreator = path.resolve(process.cwd(), './get-schema')
        console.info(pathToSchemaCreator)
        const creator = require(pathToSchemaCreator)
        const result = creator()
        const json = JSON.stringify(result, null, '  ')
        await fs.writeFile(path.resolve(process.cwd(), 'schema.json'), json)
        console.info('Done')
    } catch (err) {
        console.error(err)
        process.exit(1)
    }
}

main()