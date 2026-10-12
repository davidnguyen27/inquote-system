import {HttpProblem} from '../../http/problem.js';
export class PublicViewDto {
  constructor(public readonly token:string){}
  static parse(body:unknown):PublicViewDto {
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'token'))throw new HttpProblem(404,'LINK_UNAVAILABLE');
    const token=(body as {token:unknown}).token;if(typeof token!=='string')throw new HttpProblem(404,'LINK_UNAVAILABLE');return new PublicViewDto(token);
  }
}
