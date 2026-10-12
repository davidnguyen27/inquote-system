import {createHash,createHmac,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import type {AppConfig} from '../../config/env.js';
import type {ViewingAccess} from '../../generated/prisma/client.js';
import {HttpProblem} from '../../http/problem.js';
import {equalBytes,tokenBytes} from '../auth/security.js';

export type ReviewBinding={actorId:string;quotationId:string;versionId:string;quotationRevision:number;versionRevision:number;companyRevision:number;recoveryEpoch:string;presentationHash:string};
export class ReviewTokens {
  constructor(private readonly key:Buffer){}
  issue(binding:ReviewBinding,now:Date):string {
    const payload=Buffer.from(JSON.stringify({format:1,binding,expiresAt:now.getTime()+600_000})).toString('base64url');
    return payload+'.'+createHmac('sha256',this.key).update('share-review:'+payload).digest('base64url');
  }
  verify(token:unknown,binding:ReviewBinding,now:Date):void {
    if(JSON.stringify(this.read(token,now))!==JSON.stringify(binding))throw new HttpProblem(409,'REVIEW_STALE');
  }
  read(token:unknown,now:Date):ReviewBinding {
    try {
      if(typeof token!=='string'||token.length>4096||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))throw Error();
      const [payload,signature]=token.split('.') as [string,string];
      if(!equalBytes(tokenBytes(signature),createHmac('sha256',this.key).update('share-review:'+payload).digest()))throw Error();
      const decoded=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
      if(decoded.format!==1||!decoded.binding||!Number.isSafeInteger(decoded.expiresAt)||now.getTime()>=decoded.expiresAt)throw Error();
      return decoded.binding as ReviewBinding;
    }catch{throw new HttpProblem(409,'REVIEW_STALE');}
  }
}
type GrantIdentity=Pick<ViewingAccess,'quotationId'|'versionId'|'generation'>;
type EncryptedGrant=GrantIdentity & Pick<ViewingAccess,'tokenHash'|'tokenCiphertext'|'tokenNonce'|'tokenTag'|'encryptionKeyId'>;
export function accessETag(row:GrantIdentity,revision:number,epoch:string):string {
  return '"'+createHash('sha256').update(JSON.stringify([epoch,'access',row.quotationId,row.versionId,row.generation,revision])).digest('base64url')+'"';
}
export class ViewingTokens {
  constructor(private readonly config:AppConfig){}
  digest(token:string):Uint8Array<ArrayBuffer>{return new Uint8Array(createHash('sha256').update(tokenBytes(token)).digest());}
  private aad(row:GrantIdentity){return Buffer.from(JSON.stringify(['viewing-v1',row.quotationId,row.versionId,row.generation]));}
  issue(quotationId:string,versionId:string,generation:string){
    return this.encrypt(randomBytes(32),{quotationId,versionId,generation});
  }
  reencrypt(row:EncryptedGrant){
    return this.encrypt(tokenBytes(this.recover(row)),row);
  }
  private encrypt(raw:Buffer,identity:GrantIdentity){
    const key=this.config.viewingKeys.get(this.config.viewingKeyId);if(!key)throw new HttpProblem(503,'SERVICE_UNAVAILABLE');
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(this.aad(identity));
    return {tokenHash:new Uint8Array(createHash('sha256').update(raw).digest()),tokenCiphertext:new Uint8Array(Buffer.concat([cipher.update(raw),cipher.final()])),tokenNonce:new Uint8Array(nonce),tokenTag:new Uint8Array(cipher.getAuthTag()),encryptionKeyId:this.config.viewingKeyId};
  }
  recover(row:EncryptedGrant):string {
    try{
      const key=this.config.viewingKeys.get(row.encryptionKeyId??'');
      if(!key||!row.tokenCiphertext||!row.tokenNonce||!row.tokenTag)throw Error();
      const decipher=createDecipheriv('aes-256-gcm',key,row.tokenNonce);decipher.setAAD(this.aad(row));decipher.setAuthTag(row.tokenTag);
      const raw=Buffer.concat([decipher.update(row.tokenCiphertext),decipher.final()]);
      if(raw.length!==32||!equalBytes(createHash('sha256').update(raw).digest(),row.tokenHash))throw Error();
      return raw.toString('base64url');
    }catch{throw new HttpProblem(503,'SERVICE_UNAVAILABLE');}
  }
}
