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
const { synced } = await electric.db.lww_registers.sync()
await synced

/* webserver */
const port = process.env.PORT || 3000;
const app: Express = express();
app.use(express.json())

app.get("/r/:k", async (req: Request, res: Response) => {
    const value = await electric.db.lww_registers.findUnique({
        where: {
            k: parseInt(req.params.k, 10)
        }
    })
    res.send(value);
});

app.get("/w/:k/:v", async (req: Request, res: Response) => {
    const result = await electric.db.lww_registers.upsert({
        create: {
            k: parseInt(req.params.k, 10),
            v: parseInt(req.params.v, 10)
        },
        update: {
            v: parseInt(req.params.v, 10)
        },
        where: {
            k: parseInt(req.params.k, 10)
        }
    })
    res.send(result);
});

app.get("/list", async (req: Request, res: Response) => {
    const result = await electric.db.lww_registers.findMany()
    res.send(result);
});

app.get("/list-sql", async (req: Request, res: Response) => {
    const result = await electric.db.raw({ sql: "SELECT * FROM lww_registers;" })
    res.send(result);
});

app.post("/better-sqlite3", (req: Request, res: Response) => {
    const insert = conn.prepare(
        'INSERT INTO lww_registers (k,v) VALUES (@k, @v) ON CONFLICT(k) DO UPDATE SET v = @v');

    const select = conn.prepare(
        'SELECT k,v FROM lww_registers WHERE k = @k');

    const result = Array()

    const txn = conn.transaction((mops) => {
        for (const mop of mops)
            switch (mop.f) {
                case 'r':
                    const read = <any>select.get(mop)
                    if (read == undefined) {
                        result.push({ 'f': 'r', 'k': mop.k, 'v': null })
                    } else {
                        result.push({ 'f': 'r', 'k': mop.k, 'v': read.v })
                    }
                    break;
                case 'w':
                    const write = insert.run(mop);
                    assert(write.changes == 1)
                    result.push(mop)
                    break;
            }
    });

    txn(req.body.value)
    res.send({ 'type': 'ok', 'value': result })
});

app.listen(port, () => {
    console.log(`[server]: Server is running at http://localhost:${port}`);
});
