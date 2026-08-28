import Dexie, {type Table} from "dexie";
export type Note={id:string;parentId:string|null;title:string;content:string;createdAt:number;updatedAt:number;sortOrder:number;isFavorite:boolean;isArchived:boolean;isPinned:boolean;tags:string[]};
export type Revision={id:string;noteId:string;content:string;title:string;createdAt:number};
class NestiDB extends Dexie{notes!:Table<Note,string>; revisions!:Table<Revision,string>;
 constructor(){super("nesti-db");this.version(1).stores({notes:"id,parentId,updatedAt,isArchived,isFavorite,isPinned",revisions:"id,noteId,createdAt"});}
}
export const db=new NestiDB();