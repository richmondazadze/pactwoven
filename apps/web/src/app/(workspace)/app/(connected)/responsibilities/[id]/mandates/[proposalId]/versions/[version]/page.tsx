import { MandateProposalReview } from '@/components/mandate-proposal-review';
export const metadata={title:'Mandate proposal'};
export default async function ProposalPage({params}:{params:Promise<{id:string;proposalId:string;version:string}>}){const {id,proposalId,version}=await params;return <MandateProposalReview responsibilityId={id} proposalId={proposalId} version={version}/>;}
