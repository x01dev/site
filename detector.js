// js/detector.js
import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm';

const CSV_URL = 'https://raw.githubusercontent.com/x01dev/dbshi/refs/heads/main/shingles_coords.csv';

// Only these two roof codes match. Add legacy typos here if you find any.
const VALID_ROOFS = [
  'AS - ASPHALT',
  'AB - ASBESTOS SHINGLE',
  'AB - ABESTOS SHINGLE', // legacy typo, kept for safety
];

let cachedDb = null;

async function getDb() {
  if (cachedDb) return cachedDb;

  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);

  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);

  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  const conn = await db.connect();
  await conn.query('INSTALL spatial');
  await conn.query('LOAD spatial');
  await conn.query('SET geometry_always_xy = true');
  await conn.close();

  cachedDb = db;
  return db;
}

/**
 * @param {Array<{id:string,label:string,geometry:object}>} stormPolygons
 * @param {{roofTypes?:string[], minYear?:number, maxResults?:number}} opts
 * @returns {Promise<Array>}
 */
export async function runDetector(stormPolygons, opts = {}) {
  if (!stormPolygons || stormPolygons.length === 0) {
    throw new Error('No storm polygons provided.');
  }

  const roofTypes = (opts.roofTypes || VALID_ROOFS).filter(r => VALID_ROOFS.includes(r));
  if (roofTypes.length === 0) {
    throw new Error('No valid roof types selected.');
  }
  const minYear = opts.minYear ?? 1900;
  const maxResults = opts.maxResults ?? 20000;

  const db = await getDb();
  const conn = await db.connect();

  try {
    const polygonConditions = stormPolygons.map((p) => {
      const geomJson = JSON.stringify(p.geometry).replace(/'/g, "''");
      return `ST_Contains(ST_GeomFromGeoJSON('${geomJson}'), ST_Point(lon, lat))`;
    }).join(' OR ');

    const roofList = roofTypes.map(r => `'${r.replace(/'/g, "''")}'`).join(',');

    const sql = `
      SELECT
        apn, lat, lon, roof_code, owner, address, city, state, zip,
        "year" AS year_built, sqft
      FROM read_csv('${CSV_URL}',
        header = true,
        columns = {
          apn: 'VARCHAR',
          lat: 'DOUBLE',
          lon: 'DOUBLE',
          roof_code: 'VARCHAR',
          owner: 'VARCHAR',
          address: 'VARCHAR',
          city: 'VARCHAR',
          state: 'VARCHAR',
          zip: 'VARCHAR',
          "year": 'INTEGER',
          sqft: 'INTEGER'
        }
      )
      WHERE roof_code IN (${roofList})
        AND ("year" IS NULL OR "year" >= ${Number(minYear)})
        AND (${polygonConditions})
      LIMIT ${Number(maxResults)}
    `;

    console.log('[detector] Query:\n' + sql);
    const t0 = performance.now();
    const result = await conn.query(sql);
    const t1 = performance.now();
    console.log(`[detector] ${result.numRows} rows in ${(t1 - t0).toFixed(0)}ms`);

    return result.toArray().map(row => {
      const o = row.toJSON();
      return {
        apn: o.apn,
        lat: o.lat,
        lon: o.lon,
        roof_code: o.roof_code,
        owner: o.owner,
        address: o.address,
        city: o.city,
        state: o.state,
        zip: o.zip,
        year_built: o.year_built,
        sqft: o.sqft,
      };
    });
  } finally {
    await conn.close();
  }
}

export { VALID_ROOFS };
