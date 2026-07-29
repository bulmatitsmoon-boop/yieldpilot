const anchor=require("@coral-xyz/anchor");
const {Connection,Keypair,PublicKey}=require("@solana/web3.js");
const fs=require("fs"),path=require("path"),os=require("os");
const VAULT=new PublicKey("5XpzWiE8jb53CShYv19UoXcY2AywjeXpfwCff8mgrNYn");
const VTOK=new PublicKey("4HFsLb9xconKtmszwRDCC8aGuMXjk523kaR5KkSh9sDZ");
(async()=>{
  const keeper=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(os.homedir(),".config/solana/id.json"),"utf8"))));
  const c=new Connection("http://127.0.0.1:8899",{commitment:"confirmed"});
  const provider=new anchor.AnchorProvider(c,new anchor.Wallet(keeper),{commitment:"confirmed"});
  const idl=JSON.parse(fs.readFileSync(path.resolve(__dirname,"idl_upgrade.json"),"utf8"));
  idl.address="8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH";
  const program=new anchor.Program(idl,provider);
  const before=(await c.getAccountInfo(VAULT)).data.readBigUInt64LE(288);
  const idle=(await c.getAccountInfo(VTOK)).data.readBigUInt64LE(64).toString();
  console.log("BEFORE: total_deposits =",before.toString(),"| idle =",idle,"| (deployed = 0)");
  try{
    const sig=await program.methods.reconcile().accounts({keeper:keeper.publicKey,vault:VAULT,vaultTokenAccount:VTOK}).rpc({commitment:"confirmed"});
    const after=(await c.getAccountInfo(VAULT)).data.readBigUInt64LE(288);
    console.log("reconcile tx:",sig);
    console.log("AFTER : total_deposits =",after.toString());
    const expected=BigInt(idle);
    console.log(after===expected ? "\n*** PASS *** reconcile corrected "+before+" -> "+after+" (= idle + deployed)" : "\n*** FAIL *** expected "+expected+", got "+after);
  }catch(e){ console.log("reconcile FAILED:",(e.message||"").split("\n")[0]); (e.logs||[]).slice(-10).forEach(l=>console.log("  "+l)); }
})().catch(e=>{console.error("FATAL",e.message);process.exit(1);});
