import type {AppConfig} from '../../config/env.js';
import {HttpProblem} from '../../http/problem.js';
import {PublicationDocument} from '../quotations/publication-document.js';
import {QuotationMapper} from '../quotations/quotations.mapper.js';
import {ViewingTokens} from '../quotations/publication-security.js';
import {PublicViewingRepository} from './public-viewing.repository.js';
import {PublicViewDto} from './public-viewing.dto.js';
export class PublicViewingService {
  private readonly tokens:ViewingTokens;
  private readonly document:PublicationDocument;
  constructor(config:AppConfig,private readonly repository:PublicViewingRepository){this.tokens=new ViewingTokens(config);this.document=new PublicationDocument(new QuotationMapper(config.recoveryEpoch));}
  async read(body:unknown){
    let digest:Uint8Array<ArrayBuffer>;
    try{
      digest=this.tokens.digest(PublicViewDto.parse(body).token);
    }catch{throw new HttpProblem(404,'LINK_UNAVAILABLE');}
    const {quote,version}=await this.repository.read(digest);
    if(!version.sharedAt)throw new HttpProblem(404,'LINK_UNAVAILABLE');
    return this.document.public(quote,version,this.document.recalculate(version),this.document.snapshot(version.content),version.sharedAt.toISOString());
  }
}
