// import type { Collection, Db, Filter, OptionalUnlessRequiredId, WithId } from 'mongodb';
// import { ObjectId } from 'mongodb';
// import type { PaginationInput } from '../pagination/pagination';
// import { toPagination, toPageMeta, type PageMeta } from '../pagination/pagination';

// export type PageResult<T> = {
//   items: WithId<T>[];
//   meta: PageMeta;
// };

// export class BaseRepository<T extends Record<string, any>> {
//   protected readonly col: Collection<T>;

//   constructor(db: Db, collectionName: string) {
//     this.col = db.collection<T>(collectionName);
//   }

//   async createOne(doc: OptionalUnlessRequiredId<T>): Promise<WithId<T>> {
//     const res = await this.col.insertOne(doc);
//     const created = await this.col.findOne({ _id: res.insertedId } as Filter<T>);
//     // created should exist, but keep safe:
//     return created as WithId<T>;
//   }

//   async findById(id: string): Promise<WithId<T> | null> {
//     return this.col.findOne({ _id: new ObjectId(id) } as Filter<T>);
//   }

//   async updateById(id: string, patch: Partial<T>): Promise<WithId<T> | null> {
//     await this.col.updateOne(
//       { _id: new ObjectId(id) } as Filter<T>,
//       { $set: patch as any },
//     );
//     return this.findById(id);
//   }

//   async deleteById(id: string): Promise<boolean> {
//     const res = await this.col.deleteOne({ _id: new ObjectId(id) } as Filter<T>);
//     return res.deletedCount === 1;
//   }

//   async findPage(filter: Filter<T>, input: PaginationInput): Promise<PageResult<T>> {
//     const p = toPagination(input);
//     const [items, total] = await Promise.all([
//       this.col.find(filter).skip(p.skip).limit(p.limit).toArray(),
//       this.col.countDocuments(filter),
//     ]);

//     return { items, meta: toPageMeta(p, total) };
//   }
// }
