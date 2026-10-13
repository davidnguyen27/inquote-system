import type { AppConfig } from "../../config/env.js";
import { HttpProblem } from "../../http/problem.js";
import { AuthRepository } from "../auth/auth.repository.js";
import { CommonMutationService, resourceETag, type WriteHeaders } from "../common/common-data.js";
import { textField, emailField } from "../../http/text-validation.js";
import type { CompanyWriteDto } from "./company.dto.js";
import { CompanyMapper } from "./company.mapper.js";
import { CompanyRepository } from "./company.repository.js";
export class CompanyService {
  private readonly mapper: CompanyMapper;
  constructor(private readonly config: AppConfig,private readonly auth: AuthRepository,
    private readonly repository: CompanyRepository,private readonly mutations: CommonMutationService) {
    this.mapper=new CompanyMapper(config.recoveryEpoch);
  }
  authorize(token: string | undefined) { return this.mutations.authorize(token); }
  read(token: string | undefined) {
    return this.auth.withSession(token,{allowLimited:false},async context=>this.mapper.read(await this.repository.read(context.tx)));
  }
  update(token: string | undefined,csrf: string | undefined,body: CompanyWriteDto,headers: WriteHeaders) {
    return this.mutations.write(token,csrf,headers,{kind:"UPDATE_COMPANY",method:"PUT",route:"/api/v1/company",
      body:{displayName:body.displayName,address:body.address,phone:body.phone,email:body.email}},async (context,precondition)=>{
      const current=await this.repository.lock(context.tx);
      if(precondition!==resourceETag("company",1,current.revision,this.config.recoveryEpoch))throw new HttpProblem(412,"REVISION_CONFLICT");
      const normalized={displayName:textField(body.displayName,"/displayName",200),address:textField(body.address,"/address",500),
        phone:textField(body.phone,"/phone",50),email:emailField(body.email,"/email","contact")};
      const saved=await this.repository.update(context.tx,normalized,context.now);
      return {resourceIds:{companyId:1},appliedRevisions:{company:saved.revision}};
    });
  }
}
