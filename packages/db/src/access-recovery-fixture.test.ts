import { describe,expect,it } from 'vitest';
import { validateRecoveryFixtureTargets } from './access-recovery.test-support.js';

const urls=(port='55439')=>['admin','runtime','bootstrap','access','mandate'].map(label=>{
  const url=new URL(`postgresql://127.0.0.1:${port}/pactwoven_recovery_b1_test`);
  url.username=label==='admin'?'postgres':`pactwoven_recovery_b1_test_${label}`;
  return url;
});
const ci={CI:'true',GITHUB_ACTIONS:'true'};

describe('exclusive recovery fixture target qualification',()=>{
  it('permits the existing local target and only explicitly qualified CI on its separate port',()=>{
    expect(()=>validateRecoveryFixtureTargets(urls(),{})).not.toThrow();
    expect(()=>validateRecoveryFixtureTargets(urls('55440'),ci)).not.toThrow();
    expect(()=>validateRecoveryFixtureTargets(urls(),ci)).not.toThrow();
  });
  it.each([{}, {CI:'true'}, {GITHUB_ACTIONS:'true'}, {CI:'1',GITHUB_ACTIONS:'true'}, {CI:'true',GITHUB_ACTIONS:'1'}, {CI:'false',GITHUB_ACTIONS:'true'}])
  ('refuses the CI target without both exact opt-ins: %j',environment=>{
    expect(()=>validateRecoveryFixtureTargets(urls('55440'),environment)).toThrow('Only the exclusive recovery target');
  });
  it.each(['localhost','::1','192.0.2.1','db.example.test'])('refuses other host %s',host=>{
    const targets=urls('55440');for(const target of targets)target.hostname=host==='::1'?'[::1]':host;
    expect(()=>validateRecoveryFixtureTargets(targets,ci)).toThrow('Only the exclusive recovery target');
  });
  it.each(['5432','55441',''])('refuses other port %s',port=>{
    const targets=urls();for(const target of targets)target.port=port;
    expect(()=>validateRecoveryFixtureTargets(targets,ci)).toThrow('Only the exclusive recovery target');
  });
  it.each(['pactwoven_dev','pactwoven_backend_test','pactwoven_mandate_b1b_test','production','%70actwoven_recovery_b1_test'])('refuses other database %s',database=>{
    const targets=urls();for(const target of targets)target.pathname=`/${database}`;
    expect(()=>validateRecoveryFixtureTargets(targets,ci)).toThrow('Only the exclusive recovery target');
  });
  it.each(['scheme','query','fragment','role','missing-admin','missing','duplicate','mixed-target'])('refuses %s overrides before connection',change=>{
    const targets=urls();
    if(change==='scheme')targets[0]=new URL('https://postgres@127.0.0.1:55439/pactwoven_recovery_b1_test');
    if(change==='query')targets[0]!.search='?host=other.example.test';
    if(change==='fragment')targets[0]!.hash='#override';
    if(change==='role')targets[3]!.username='pactwoven_ci_access';
    if(change==='missing-admin')targets[0]!.username='';
    if(change==='missing')targets.pop();
    if(change==='duplicate')targets[0]!.username=targets[1]!.username;
    if(change==='mixed-target')targets[4]!.port='55440';
    expect(()=>validateRecoveryFixtureTargets(targets,ci)).toThrow();
  });
});
