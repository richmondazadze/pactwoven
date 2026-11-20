use anchor_lang::prelude::*;

#[error_code]
pub enum Chain0Error {
    #[msg("Unexpected remaining accounts")]
    UnexpectedAccounts,
    #[msg("The account has an unsupported length")]
    WrongAccountLength,
    #[msg("The mint is not the accepted development mint")]
    WrongMint,
    #[msg("The mint configuration has changed or is unsupported")]
    WrongMintConfiguration,
    #[msg("The program is not linked to the supplied loader-v3 ProgramData")]
    WrongProgramData,
    #[msg("The bootstrap signer is not the current upgrade authority")]
    WrongUpgradeAuthority,
    #[msg("The program deployment changed after configuration")]
    DeploymentChanged,
    #[msg("The configuration version, namespace or stage is unsupported")]
    InvalidConfiguration,
    #[msg("The configuration identity or intent hash is inconsistent")]
    InvalidConfigurationIdentity,
    #[msg("A registration identifier cannot be nil")]
    NilRegistrationIdentity,
    #[msg("The owner binding digest cannot be zero")]
    MissingOwnerBinding,
    #[msg("The registrar must match the configured registration signer")]
    WrongRegistrar,
    #[msg("Owner and registrar must be distinct non-default keys")]
    InvalidOwner,
    #[msg("The initialized vault is not an empty original-SPL custody account")]
    InvalidVault,
}
