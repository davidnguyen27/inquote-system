import {parseArgs} from 'node:util';
import {loadLocalEnvironment,parseConfig} from '../config/env.js';
import {Database} from '../database/prisma.js';
import {HttpProblem} from '../http/problem.js';
import {MaintenanceService} from './maintenance.service.js';

async function run():Promise<void>{
  const args=parseArgs({options:{'batch-size':{type:'string'}},allowPositionals:true}),[command,action]=args.positionals;
  if((command!=='housekeeping'&&command!=='keys')||args.positionals.length!==(command==='keys'?2:1)||
    (command==='keys'&&!['audit','reencrypt-viewing','revoke-sessions'].includes(action??''))||
    (action==='audit'&&args.values['batch-size']!==undefined))throw new HttpProblem(400,'INVALID_REQUEST');
  const input=args.values['batch-size']??'100';if(!/^[1-9]\d{0,3}$/.test(input)||Number(input)>1000)throw new HttpProblem(400,'INVALID_REQUEST');
  loadLocalEnvironment();const config=parseConfig(process.env),database=new Database(config.databaseUrl);
  try{
    const service=new MaintenanceService(config,database),limit=Number(input);
    const result=command==='housekeeping'?await service.housekeeping(limit):action==='audit'?await service.auditKeys():action==='reencrypt-viewing'?await service.reencryptViewing(limit):await service.revokeSessions(limit);
    process.stdout.write(JSON.stringify(result)+'\n');if('safe' in result&&!result.safe)process.exitCode=1;
  }finally{await database.close();}
}
run().catch(error=>{
  // Never echo arguments, configuration, SQL, connection strings, key values or raw links.
  process.stderr.write((error instanceof HttpProblem?error.code:'OPERATOR_FAILED')+'\n');process.exitCode=1;
});
