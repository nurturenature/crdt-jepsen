import assert from "assert";
import dotenv from "dotenv";
import express, { Express, Request, Response } from "express";

dotenv.config();

/* ElectricSQL */
import Database from 'better-sqlite3'
import { electrify } from 'electric-sql/node'
import { schema } from './generated/client/index.js'
import { ElectricConfig } from "electric-sql/config";
import { insecureAuthToken } from 'electric-sql/auth'

/* create a database and client */
const config: ElectricConfig = {
    url: 'http://electricsql:5133',
    auth: {
        token: insecureAuthToken({ "sub": "insecure" })
    },
    debug: true
}
const conn = new Database('electric.db')
conn.pragma('journal_mode = WAL')
const electric = await electrify(conn, schema, config)

/* sync database */
const { synced } = await electric.db.gset.sync()
await synced

/* webserver */
const port = process.env.PORT || 3000;
const app: Express = express();
app.use(express.json())

app.get("/r/:k", async (req: Request, res: Response) => {
    const value = await electric.db.gset.findMany({
        where: {
            k: parseInt(req.params.k, 10)
        }
    })
    if (value == null) {
        res.send({
            'k': req.params.k,
            'v': null
        });
    } else {
        res.send(value);
    }
});

app.get("/w/:id/:k/:v", async (req: Request, res: Response) => {
    const result = await electric.db.gset.upsert({
        create: {
            id: parseInt(req.params.id, 10),
            k: parseInt(req.params.k, 10),
            v: parseInt(req.params.v, 10)
        },
        update: {
            k: parseInt(req.params.k, 10),
            v: parseInt(req.params.v, 10)
        },
        where: {
            id: parseInt(req.params.id, 10)
        }
    })
    res.send(result);
});

app.get("/list", async (req: Request, res: Response) => {
    const result = await electric.db.gset.findMany()
    res.send(result);
});

app.get("/list-sql", async (req: Request, res: Response) => {
    const result = await electric.db.raw({ sql: "SELECT * FROM gset;" })
    res.send(result);
});

app.post("/electric-findMany", async (req: Request, res: Response) => {
    const result = await electric.db.gset.findMany(req.body)
    res.send(result)
});

app.post("/electric-createMany", async (req: Request, res: Response) => {
    const result = await electric.db.gset.createMany(req.body)
    res.send(result)
});

app.post("/better-sqlite3", (req: Request, res: Response) => {
    const insert = conn.prepare(
        'INSERT INTO gset (id,k,v) VALUES (@id, @k, @v)');

    const select = conn.prepare(
        'SELECT k,v FROM gset WHERE k = @k');

    const result = Array()

    const txn = conn.transaction((mops) => {
        for (const mop of mops)
            switch (mop.f) {
                case 'r':
                    const read = <any>select.all(mop)
                    if (read.length == 0) {
                        result.push({ 'f': 'r', 'k': mop.k, 'v': null })
                    } else {
                        result.push({ 'f': 'r', 'k': mop.k, 'v': read })
                    }
                    break;
                case 'w':
                    const write = insert.run(mop);
                    assert(write.changes == 1)
                    result.push(mop)
                    break;
            }
    });

    try {
        txn(req.body.value)
        res.send({ 'type': 'ok', 'value': result })
    } catch (e) {
        // TODO: SQLITE_LOCKED 
        res.send({ 'type': 'info', 'error': e })
    }
});

app.listen(port, () => {
    console.log(`[server]: Server is running at http://localhost:${port}`);
});
