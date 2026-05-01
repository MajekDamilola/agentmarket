// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC20Like {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * ArcIdCardNFT
 *
 * A minimal soulbound ERC-721-style collectible for Arc ID cards.
 * Minting requires:
 * 1. A backend-signed authorization for the exact metadata payload.
 * 2. A 5.00 USDC payment on Arc routed through this contract.
 *
 * Tokens are intentionally non-transferable because they represent a
 * wallet-bound Arc identity and paid unlock history.
 */
contract ArcIdCardNFT {
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    string public constant name = "Arc ID Season 1";
    string public constant symbol = "ARCID";
    string public constant SIGNING_DOMAIN = "AgentMarket Arc ID";
    string public constant SIGNATURE_VERSION = "1";

    bytes4 private constant ERC165_INTERFACE_ID = 0x01ffc9a7;
    bytes4 private constant ERC721_INTERFACE_ID = 0x80ac58cd;
    bytes4 private constant ERC721_METADATA_INTERFACE_ID = 0x5b5e139f;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant MINT_AUTHORIZATION_TYPEHASH =
        keccak256("MintAuthorization(address minter,bytes32 metadataHash,uint256 expiresAt)");

    address public owner;
    address public treasury;
    address public mintSigner;
    uint256 public mintPrice;
    uint256 public totalSupply;

    mapping(uint256 => address) private owners;
    mapping(address => uint256) private balances;
    mapping(uint256 => string) private tokenUris;
    mapping(address => uint256) public walletTokenId;
    mapping(bytes32 => bool) public usedAuthorizations;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event ArcIdMinted(address indexed minter, uint256 indexed tokenId, uint256 pricePaid);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event MintSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event MintPriceUpdated(uint256 previousPrice, uint256 newPrice);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not contract owner");
        _;
    }

    constructor(address initialTreasury, address initialMintSigner, uint256 initialMintPrice) {
        require(initialTreasury != address(0), "Treasury required");
        require(initialMintSigner != address(0), "Mint signer required");
        require(initialMintPrice > 0, "Mint price required");

        owner = msg.sender;
        treasury = initialTreasury;
        mintSigner = initialMintSigner;
        mintPrice = initialMintPrice;

        emit OwnershipTransferred(address(0), msg.sender);
        emit TreasuryUpdated(address(0), initialTreasury);
        emit MintSignerUpdated(address(0), initialMintSigner);
        emit MintPriceUpdated(0, initialMintPrice);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == ERC165_INTERFACE_ID
            || interfaceId == ERC721_INTERFACE_ID
            || interfaceId == ERC721_METADATA_INTERFACE_ID;
    }

    function balanceOf(address wallet) external view returns (uint256) {
        require(wallet != address(0), "Zero address");
        return balances[wallet];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address tokenOwner = owners[tokenId];
        require(tokenOwner != address(0), "Token not minted");
        return tokenOwner;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(owners[tokenId] != address(0), "Token not minted");
        return tokenUris[tokenId];
    }

    function approve(address, uint256) external pure {
        revert("Arc ID is soulbound");
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function setApprovalForAll(address, bool) external pure {
        revert("Arc ID is soulbound");
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure {
        revert("Arc ID is soulbound");
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert("Arc ID is soulbound");
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert("Arc ID is soulbound");
    }

    function mintArcId(
        string calldata metadataUri,
        uint256 expiresAt,
        bytes calldata signature
    ) external returns (uint256 tokenId) {
        require(walletTokenId[msg.sender] == 0, "Arc ID already minted");
        require(bytes(metadataUri).length > 0, "Metadata required");
        require(block.timestamp <= expiresAt, "Authorization expired");

        bytes32 digest = _mintAuthorizationDigest(msg.sender, keccak256(bytes(metadataUri)), expiresAt);
        require(!usedAuthorizations[digest], "Authorization already used");
        require(_recoverSigner(digest, signature) == mintSigner, "Invalid mint authorization");

        usedAuthorizations[digest] = true;
        require(
            IERC20Like(USDC).transferFrom(msg.sender, treasury, mintPrice),
            "USDC transfer failed"
        );

        tokenId = ++totalSupply;
        owners[tokenId] = msg.sender;
        balances[msg.sender] += 1;
        walletTokenId[msg.sender] = tokenId;
        tokenUris[tokenId] = metadataUri;

        emit Transfer(address(0), msg.sender, tokenId);
        emit ArcIdMinted(msg.sender, tokenId, mintPrice);
    }

    function mintAuthorizationDigest(
        address minter,
        string calldata metadataUri,
        uint256 expiresAt
    ) external view returns (bytes32) {
        return _mintAuthorizationDigest(minter, keccak256(bytes(metadataUri)), expiresAt);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Treasury required");
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setMintSigner(address newMintSigner) external onlyOwner {
        require(newMintSigner != address(0), "Mint signer required");
        emit MintSignerUpdated(mintSigner, newMintSigner);
        mintSigner = newMintSigner;
    }

    function setMintPrice(uint256 newMintPrice) external onlyOwner {
        require(newMintPrice > 0, "Mint price required");
        emit MintPriceUpdated(mintPrice, newMintPrice);
        mintPrice = newMintPrice;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Owner required");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function _mintAuthorizationDigest(
        address minter,
        bytes32 metadataHash,
        uint256 expiresAt
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                MINT_AUTHORIZATION_TYPEHASH,
                minter,
                metadataHash,
                expiresAt
            )
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(SIGNING_DOMAIN)),
                keccak256(bytes(SIGNATURE_VERSION)),
                block.chainid,
                address(this)
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "Invalid signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Invalid signature version");

        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0), "Invalid signature");
        return recovered;
    }
}
