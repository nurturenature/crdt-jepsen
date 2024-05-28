import assert from "assert"
import dotenv from "dotenv"
import express, { Express, Request, Response } from "express"

dotenv.config();

/* electric-sqlite */
import Database from 'better-sqlite3'
import { electrify } from 'electric-sql/node'
import { schema } from './generated/client/index.js'
import { ElectricConfig } from "electric-sql/config"
import { insecureAuthToken } from 'electric-sql/auth'

/* create an electric conn, database, and client */
const config: ElectricConfig = {
    url: process.env.ELECTRIC_SERVICE || 'http://electric:5133',
    debug: true
}
const e_conn = new Database('electric.db')
e_conn.pragma('journal_mode = WAL')
const electric = await electrify(e_conn, schema, config)
await electric.connect(insecureAuthToken({ "sub": "insecure" }))

/* sync databases */
const { synced: buckets } = await electric.db.buckets.sync()
await buckets
const { synced: lww } = await electric.db.lww.sync()
await lww

/* create a conn for db transactions, see https://www.sqlite.org/isolation.html */
/* a shared conn has no isolation */
const txn_conn = new Database('electric.db')
txn_conn.pragma('journal_mode = WAL')

/* webserver */
const port = process.env.CLIENT_PORT || 8089
const app: Express = express();
app.use(express.json())

app.get("/lww/list", async (req: Request, res: Response) => {
    const result = await electric.db.lww.findMany()
    res.send(result);
});


/* note use of foreign key driven updates */
const doc_update = electric.db.buckets.update({
    where: { bucket: 0 },
    data: {
        v: null,
        lww: {
            update: {
                data: { v: "0" },
                where: { k: 0 }
            }
        }
    },
    include: { lww: true }
})

app.post("/lww/update", async (req: Request, res: Response) => {
    const result = await electric.db.buckets.update(req.body)
    res.send(result)
});

app.post("/lww/updateMany", async (req: Request, res: Response) => {
    const result = await electric.db.lww.updateMany(req.body)
    res.send(result)
});

app.post("/lww/findMany", async (req: Request, res: Response) => {
    const result = await electric.db.lww.findMany(req.body)
    res.send(result)
});

app.post("/lww/electric-findUnique", async (req: Request, res: Response) => {
    const result = await electric.db.lww.findUnique(req.body)
    res.send(result)
});

app.post("/lww/electric-upsert", async (req: Request, res: Response) => {
    const result = await electric.db.lww.upsert(req.body)
    res.send(result)
});

app.post("/lww/better-sqlite3", (req: Request, res: Response) => {
    const upsert = txn_conn.prepare(
        'INSERT INTO lww (k,v,bucket) VALUES (@k,@v,0) ON CONFLICT (k) DO UPDATE SET v = v || \' \' || @v');
    const select = txn_conn.prepare(
        'SELECT k,v FROM lww WHERE k = @k');

    const result = Array()

    const txn = txn_conn.transaction((mops) => {
        for (const mop of mops)
            switch (mop.f) {
                case 'r':
                    const read = <any>select.get(mop)
                    if (read == undefined) {
                        result.push({ 'f': 'r', 'k': mop.k, 'v': null })
                    } else {
                        result.push({ 'f': 'r', 'k': read.k, 'v': read.v })
                    }
                    break;
                case 'append':
                    const write = upsert.run(mop);
                    assert(write.changes == 1)
                    result.push(mop)
                    break;
            }
    });

    try {
        txn(req.body.value)
        res.send({ 'type': 'ok', 'value': result })
    } catch (e) {
        res.send({ 'type': 'info', 'error': e })
    }
});

app.get("/control/disconnect", async (req: Request, res: Response) => {
    console.log('[electric-sqlite]: disconnect request received.')

    electric.disconnect()
    console.log('[electric-sqlite]: electric-sqlite disconnected.')

    res.send("disconnected")
});

app.get("/control/connect", async (req: Request, res: Response) => {
    console.log('[electric-sqlite]: connect request received.')

    await electric.connect()
    console.log('[electric-sqlite]: electric-sqlite connected.')

    res.send("connected")
});

app.get("/control/pragma", async (req: Request, res: Response) => {
    res.send([
        {
            "description": "electric-sqlite connection",
            "name": e_conn.name,
            "compile_options": e_conn.pragma('compile_options'),
            "journal_mode": e_conn.pragma('journal_mode', { simple: true }),
            "locking_mode": e_conn.pragma('locking_mode', { simple: true }),
            "read_uncommitted": e_conn.pragma('read_uncommitted', { simple: true })
        }]);
});

const webserver = app.listen(port, () => {
    console.log(`[electric-sqlite]: Server is listening at http://localhost:${port}`);
});