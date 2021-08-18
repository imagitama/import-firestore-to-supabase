# Export Firestore to Supabase

A script that reads your Firestore collections, creates Supabase tables and inserts the Firestore documents.

**It is designed for an _empty Supabase SQL database_ and a SQL-like Firestore database!**

Every record will have an additional `id` column (primary key) which matches the original Firestore ID.

## Schemas

Because Firestore is noSQL it does not have columns so we do not know _exactly_ how you want your PostgreSQL tables to be built (we could guess but that is risky).

So you must create your own schema (as JSON) to "map" your Firestore documents to columns. Each key in this object determines which collections are read.

As JSON:

```
{
    [collectionName]: [
        {
            source: string
            dest?: string
            colType?: 'TEXT' | 'JSONB' | 'TIMESTAMP' | 'BOOL' | ['ARRAY', type: 'TEXT' | 'JSONB' | 'TIMESTAMP' | 'BOOL'],
            fieldType?: ['REF', collectionName: string] | ['ARRAY', 'STRING' | ['REF', collectionName: string]]
        }
    ]
}
```

### Notes

If you do not provide a `dest` the `source` will be used.

If you do not provide a `colType` but you provide a `fieldType` then it will be used instead.

If your Firestore document has fields not in the schema they will be ignored.

If your schema has fields that do not exist in the Firestore document then a default will be used:

| Type        | Default             |
| ----------- | ------------------- |
| `TEXT`      | `''` (empty string) |
| `JSONB`     | `null`              |
| `TIMESTAMP` | `null`              |
| `BOOL`      | `null`              |
| `ARRAY`     | `[]` (empty array)  |

The order of collection names does not matter. The order of fields will determine column order.

Set the field type to `['REF', 'my-collection-name']` to indicate the field is a reference to another collection. The field value will be a `TEXT` string that is the ID of the referenced document ID (in future this will automatically be a foreign key).

### Limitations

Does not support nested arrays.

Does not support nested documents. Move them to a root level collection.

Arrays of objects will be stringified. If those objects contain Firestore references they will be replaced with a string like `$collectionName:$id`

### Example

In this example a foreign key will be created between a "user" and their "profile" because the field type is set to `REF`:

```json
{
  "users": [
    {
      "source": "username",
      "colType": "TEXT"
    },
    {
      "source": "profile",
      "fieldType": ["REF", "profiles"]
    }
  ],
  "profiles": [
    {
      "source": "bio",
      "colType": "TEXT"
    }
  ]
}
```

## Creating a schema programmatically

Run the script `npm run create-schema` to create a script if you have a Nodejs file named `get-schema.js` (or `./get-schema`) which exports 1 function:

```js
module.exports = () => ({
  /* schema to be JSON stringified */
})
```

## Usage

You must have a `schema.json` file in the cwd.

You must have these environment variables set. Rename the `.env.example` file to `.env` to set them easily.

| Var                            | Usage                                                |
| ------------------------------ | ---------------------------------------------------- |
| GOOGLE_APPLICATION_CREDENTIALS | Path to a service account credentials JSON file.     |
| POSTGRESQL_CONNECTION_URL      | URL to connect to your Supabase PostgreSQL database. |

Then install deps:

    npm i

Then run the script:

    npm start
    
Note that by default it does not write to Supabase (but will read your Firestore collections).

### CLI options

`--go`

Do not do a dry run. This will write to Supabase.

`--debug`

Output extra stuff to help debug.

`--collections=users,profiles,animals`

A list of collection names to process (and only them).

`--limit=100`

Limit the number of Firestore docs fetched per collection (unsorted).

`--show-creates`

Output each table create query.

`--show-first-insert`

Output the first INSERT query for each table.

## Warnings

This script will read every document in every collection. This might incur unexpected costs.

This script will insert records into your Supabase PostgreSQL database. This might incur unexpected costs.

## Troubleshooting

### Error: "must be owner of table TABLE_NAME"

Ensure the table does not already exist and you have the necessary permissions.
