import {Database} from '../../database/prisma.js';
import {HttpProblem} from '../../http/problem.js';
import {equalBytes} from '../auth/security.js';
import {QuotationsRepository} from '../quotations/quotations.repository.js';
export class PublicViewingRepository {
  constructor(private readonly database:Database){}
  async read(digest:Uint8Array<ArrayBuffer>){
    const observed=await this.database.client.viewingAccess.findUnique({where:{tokenHash:digest},select:{quotationId:true}});
    if(!observed)throw new HttpProblem(404,'LINK_UNAVAILABLE');
    return this.database.transaction(async tx=>{
      const q=observed.quotationId;await tx.$queryRaw`SELECT id FROM quotation WHERE id=${q}::uuid FOR SHARE`;
      const quote=await tx.quotation.findUnique({where:{id:q}});if(!quote?.latestSharedVersionId||quote.discardedAt)throw new HttpProblem(404,'LINK_UNAVAILABLE');
      const repository=new QuotationsRepository(),version=await repository.version(tx,q,quote.latestSharedVersionId),access=await repository.access(tx,q);
      const [clock]=await tx.$queryRaw<{now:Date}[]>`SELECT clock_timestamp() AS now`;
      if(!access||version.state!=='SHARED'||access.versionId!==version.id||access.revokedAt||clock!.now>=access.expiresAt||!equalBytes(access.tokenHash,digest))throw new HttpProblem(404,'LINK_UNAVAILABLE');
      return {quote,version};
    });
  }
}
