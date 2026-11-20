import { MandateCollection } from '@/components/mandate-collection';
export const metadata={title:'Mandate & limits'};
export default async function MandatesPage({params}:{params:Promise<{id:string}>}){const {id}=await params;return <MandateCollection responsibilityId={id}/>;}
