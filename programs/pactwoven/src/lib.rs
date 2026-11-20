use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod identity;
pub mod instructions;
pub mod state;

pub use instructions::*;

declare_id!("5UaivPxV8oQypy5mxmQCzvZXHVSMkPsZ2TKJvszyebVG");

#[program]
pub mod pactwoven {
    use super::*;

    pub fn initialize_program_config(ctx: Context<InitializeProgramConfig>) -> Result<()> {
        instructions::initialize_program_config::handle_initialize_program_config(ctx)
    }

    pub fn initialize_custody(
        ctx: Context<InitializeCustody>,
        organization_uuid: [u8; 16],
        responsibility_uuid: [u8; 16],
        owner_binding_hash: [u8; 32],
    ) -> Result<()> {
        instructions::initialize_custody::handle_initialize_custody(
            ctx,
            organization_uuid,
            responsibility_uuid,
            owner_binding_hash,
        )
    }
}
