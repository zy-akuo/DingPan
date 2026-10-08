import asyncio
from app.config import settings
from app.db import get_fundamentals
import aiosqlite

async def main():
    print("db", settings.db_path)
    codes = ["002623", "001238", "603375", "603725", "603232", "002185"]
    for c in codes:
        f = await get_fundamentals(c)
        if not f:
            print(c, "NO_DB")
        else:
            print(
                c,
                "region=",
                repr(f.get("region")),
                "free=",
                f.get("free_float_mv"),
                "top10=",
                f.get("top10_holder_pct"),
                "upd=",
                f.get("updated_at"),
            )
    async with aiosqlite.connect(settings.db_path) as db:
        cur = await db.execute("select count(*) from stock_fundamentals")
        print("fund_rows", (await cur.fetchone())[0])

asyncio.run(main())
