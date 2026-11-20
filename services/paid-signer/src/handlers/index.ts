import {attachDatabasePool} from '@vercel/functions';
import {createPaidSignerRuntime} from '../runtime';
const handler=createPaidSignerRuntime({values:()=>process.env,attach:attachDatabasePool});
export default {fetch:handler};
