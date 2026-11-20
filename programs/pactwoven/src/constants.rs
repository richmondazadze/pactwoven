use anchor_lang::prelude::*;

pub const LAYOUT_VERSION: u8 = 1;
pub const INITIALIZATION_ONLY: u8 = 0;
pub const DEVELOPMENT_NAMESPACE: u8 = 1;
pub const ASSET_DECIMALS: u8 = 6;
pub const ORIGINAL_MINT_SIZE: usize = 82;
pub const ORIGINAL_TOKEN_ACCOUNT_SIZE: usize = 165;

pub const CONFIG_SEED: &[u8] = b"pw:config:v1";
pub const CUSTODY_SEED: &[u8] = b"pw:custody:v1";
pub const VAULT_SEED: &[u8] = b"pw:vault:v1";

// This is an immutable namespace. Actual RPC genesis must be verified offchain.
pub const DEVNET_GENESIS: [u8; 32] = [
    206, 89, 219, 80, 128, 252, 44, 109, 59, 207, 124, 169, 7, 18, 211, 194, 229, 230, 194, 143,
    39, 240, 223, 187, 153, 83, 189, 176, 137, 76, 3, 171,
];
pub const TEST_MINT: Pubkey = Pubkey::new_from_array([
    59, 68, 44, 179, 145, 33, 87, 241, 58, 147, 61, 1, 52, 40, 45, 3, 43, 95, 254, 205, 1, 162,
    219, 241, 183, 121, 6, 8, 223, 0, 46, 167,
]);
pub const TOKEN_PROGRAM: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);
pub const MINT_AUTHORITY: Pubkey = Pubkey::new_from_array([
    235, 133, 68, 207, 145, 24, 39, 122, 150, 50, 233, 153, 80, 102, 101, 27, 191, 177, 64, 139,
    133, 115, 235, 192, 46, 83, 239, 171, 90, 191, 14, 11,
]);
pub const FREEZE_AUTHORITY: Pubkey = Pubkey::new_from_array([
    168, 6, 51, 255, 6, 125, 136, 223, 165, 212, 53, 123, 244, 78, 38, 206, 204, 207, 8, 102, 104,
    129, 3, 198, 186, 96, 159, 164, 76, 24, 210, 8,
]);
pub const PHYSICAL_ASSET_KEY: [u8; 32] = [
    0x34, 0xee, 0x73, 0x0c, 0xf9, 0x0d, 0x3d, 0x55, 0xea, 0x2d, 0x34, 0xe9, 0x11, 0xaa, 0x4a, 0xd9,
    0x41, 0xaa, 0xfb, 0x29, 0x66, 0x8b, 0xf4, 0x05, 0x6c, 0xfa, 0x88, 0xc6, 0xcf, 0x04, 0x92, 0xe4,
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn asset_constants_match_reviewed_public_addresses() {
        for (actual, expected) in [
            (
                Pubkey::new_from_array(DEVNET_GENESIS),
                "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
            ),
            (TEST_MINT, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
            (TOKEN_PROGRAM, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            (
                MINT_AUTHORITY,
                "GrNg1XM2ctzeE2mXxXCfhcTUbejM8Z4z4wNVTy2FjMEz",
            ),
            (
                FREEZE_AUTHORITY,
                "CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT",
            ),
        ] {
            assert_eq!(actual, Pubkey::from_str(expected).unwrap());
        }
        assert_eq!(TOKEN_PROGRAM, anchor_spl::token::ID);
    }
}
