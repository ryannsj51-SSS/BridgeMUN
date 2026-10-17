// Shared Model UN committee data and logic: the five SDG topics (with
// every delegate's researched speech), the real MUN procedure phases,
// vote math, and the Firestore read/write helpers for the one shared
// committee/state document. Imported by both committee.js (the
// delegate page) and chair.js (the chair dashboard) so the two pages
// can never disagree about what a phase means or how a vote is scored
// -- there is exactly one copy of this logic, not two that could drift
// apart.
import { addDoc, collection, db, doc, ensureAnonymousUser, getDoc, runTransaction, serverTimestamp, setDoc } from "./firebase.js";

// A one-line, plain-language description of what happens during each
// phase, researched from real MUN procedure guides -- shown in the
// timeline table so a visitor new to MUN knows what each step means.
const COMMITTEE_PHASE_DESCRIPTIONS = [
  "Chair sets up the topic and checks who's present.",
  "Delegates give prepared opening speeches, in order.",
  "A delegate proposes a motion for what happens next.",
  "Chair opens the floor; delegates vote on the motion.",
  "Chair-recognized debate, following whichever motion passed.",
  "Delegates draft a resolution, then take a final vote on it.",
  "The session's final record and results.",
];

// The five SDG topics this committee can be assigned, each carrying the
// full opening speech an AI Delegate would give for that country under
// that topic (real-world policy research: status quo, what it wants
// from the committee, and the tension it has to defend). During Setting
// the Agenda, the chair can pick one of these directly (see chair.js);
// if the chair hasn't chosen one yet, or a topic vote fails or times
// out, one is proposed at random instead.
const COMMITTEE_TOPICS = [
  {
    id: "sdg14",
    name: "SDG 14: Life Below Water",
    description: "Conserve and sustainably use the oceans, seas, and marine resources.",
    delegates: [
      {
        country: "United States",
        speech:
          "The United States represents one of the world's largest ocean economies and one of the largest exclusive economic zones on Earth. Through the Magnuson-Stevens Act and NOAA's fisheries science, our domestic management has become a model others look to, and we are proud to back the new WTO Agreement on Fisheries Subsidies and the global fight against illegal, unreported, and unregulated fishing. We call on this committee to strengthen satellite tracking and port-state enforcement against illegal fishing fleets, to protect freedom of navigation for every nation, and to pursue a blue economy built on innovation and partnership rather than new bureaucracy. We recognize that our own record invites scrutiny, including questions about our seabed mining authority and our relationship with the Law of the Sea Convention, and we welcome this committee's engagement on those questions in good faith.",
      },
      {
        country: "Philippines",
        speech:
          "The Philippines speaks for an archipelago of more than seven thousand islands within the Coral Triangle, one of the most biodiverse marine regions on Earth, and for millions of families whose food and livelihoods depend directly on healthy seas. Our 2016 arbitral victory affirmed that international law protects coastal states against unlawful claims, and we ask this committee to give rulings like it real enforcement teeth, not just moral weight. We call for expanded climate adaptation financing for coastal communities, stronger support for marine protected areas, and firm multilateral pressure against foreign fleets that encroach on national waters. We acknowledge the challenges still facing our own coastlines, from plastic pollution to unsustainable fishing practices, and we come to this committee ready to work alongside others in addressing them.",
      },
      {
        country: "Netherlands",
        speech:
          "The Kingdom of the Netherlands speaks as a nation that lives below sea level, as home to the Delta Works, and as host to the International Court of Justice and the Permanent Court of Arbitration in The Hague. We have ratified the Agreement on Biodiversity Beyond National Jurisdiction and are expanding offshore wind across the North Sea, and we believe clean energy and marine biodiversity can share the same waters. We urge this committee to move quickly toward full implementation of that agreement, to support an ambitious global plastics treaty, and to expand marine protected area networks worldwide. We recognize that our own fishing fleets and nitrogen runoff have drawn real criticism at home, and we bring that awareness with us as we ask others to raise their ambition alongside our own.",
      },
      {
        country: "China",
        speech:
          "The People's Republic of China represents one of the world's largest fishing nations and a fleet that supplies a substantial share of the world's seafood. We have taken serious unilateral action to protect marine and freshwater life, including a ten-year fishing moratorium on the Yangtze River and seasonal closures across our own coastal waters, and we remain engaged with the WTO Agreement on Fisheries Subsidies, including its protections for developing fishing communities. We call on this committee to recognize the right of developing coastal states to build a blue economy without being held to a different standard than long-established naval and fishing powers, and to pursue genuine cooperation rather than one-sided accusations. We are aware that the scale and conduct of our distant-water fleet has drawn serious international criticism, including disputed maritime claims and labor practices aboard some vessels, and we come to this committee prepared to discuss these concerns directly.",
      },
      {
        country: "Brazil",
        speech:
          "Brazil holds jurisdiction over what we call our Blue Amazon, a maritime territory along our coast larger than the Amazon rainforest itself, and we have launched a National Strategy for a Plastic-Free Ocean targeting the roughly 1.3 million tons of plastic entering our waters every year. We are phasing out single-use plastics, banning intentionally added microplastics in cosmetics, and formalizing the waste pickers who already do so much of this work informally. We call on this committee to recognize that ocean protection and economic inclusion can move together, and to support technology and financing for coastal nations working to formalize informal recycling economies like ours. We are proud to have hosted COP30 in Bel\u00e9m and to use that platform to push ocean and climate issues together. We recognize that microplastic contamination has now been documented along our entire coastline despite these efforts, and that a plan launched is not the same as a plan completed, and we accept this committee's scrutiny of that gap.",
      },
      {
        country: "India",
        speech:
          "India's coastline supports nearly thirty million livelihoods in fisheries, and our Blue Economy framework, backed by the Pradhan Mantri Matsya Sampada Yojana, has helped raise fish production by nearly forty percent over the past five years while we invest in deep-ocean exploration through our Deep Ocean Mission. We call on this committee to support technology-sharing for developing coastal nations pursuing sustainable fisheries growth, and to recognize that feeding hundreds of millions of people from the sea responsibly is possible with the right investment. Our Sagarmala port modernization program is being designed to reduce logistics emissions along our coast at the same time. We recognize that overfishing, industrial pollution, and fragmented governance across multiple ministries remain real obstacles to translating this ambition into consistent enforcement, and that our aging fishing fleets and weak cold-chain infrastructure still limit how sustainably that growth happens, and we bring these gaps honestly into this room.",
      },
      {
        country: "Nigeria",
        speech:
          "Nigeria sits on the Gulf of Guinea, one of the most productive marine fishing grounds in West Africa, but also one of the regions most damaged by oil industry pollution, including spills that have destroyed tens of thousands of hectares of mangrove forest in the Niger Delta over the past two decades. We call on this committee to hold multinational oil operators accountable for pipeline safety and spill response in the waters and coastlines where they operate, not only in their home countries, and to support regional maritime security cooperation against illegal fishing fleets in the Gulf of Guinea. We are working to strengthen our own coastal resource management policies and enforcement capacity. We recognize that internal industry documents have shown operators continuing to run compromised pipelines through our waters despite known risks, and that our own enforcement has not always been strong enough to prevent it, and we come to this committee ready to discuss both sides of that failure.",
      },
    ],
  },
  {
    id: "sdg13",
    name: "SDG 13: Climate Action",
    description: "Take urgent action to combat climate change and its impacts.",
    delegates: [
      {
        country: "United States",
        speech:
          "The United States remains one of the largest historical and current greenhouse gas emitters, and our current administration has withdrawn from the Paris Agreement for a second time, choosing to expand oil, gas, and coal production over the emissions targets set by the previous government. We call on this committee to respect the right of every nation to reach its climate goals through the energy mix that fits its own economy, rather than through binding international mandates that ignore energy security and affordability. We support innovation-driven approaches, including nuclear power and carbon capture technology, as the fastest realistic path to lower emissions without sacrificing growth. We recognize that independent trackers now rate our climate policy as critically insufficient against the 1.5-degree goal, and that our rollback of clean energy tax credits and climate finance commitments has drawn serious criticism from allies and vulnerable nations alike, and we are prepared to defend that record before this committee.",
      },
      {
        country: "Philippines",
        speech:
          "The Philippines stands among the nations most exposed to the physical damage of a warming planet, and our newly updated national climate pledge commits to reducing or avoiding emissions by 75 percent between 2025 and 2035, one of the most ambitious targets of any developing country. We ask this committee to recognize that ambition on paper means little without finance behind it, and to commit real international support toward the climate adaptation and forest-carbon programs our communities depend on. We are building the institutions for a credible carbon market, including a national forest carbon registry, and we ask wealthier nations to treat that credibility as a reason to invest, not a reason to wait. We acknowledge that only a small fraction of our own pledge is unconditional, and that critics at home have called our plan ambitious but incomplete, and we come to this committee ready to answer for that gap honestly.",
      },
      {
        country: "Netherlands",
        speech:
          "The Kingdom of the Netherlands operates under one of the most legally binding climate frameworks in the world, our own Climate Act, which commits us to cutting emissions 55 percent by 2030, 90 percent by 2040, and to full climate neutrality by 2050. We call on this committee to match that level of legal accountability, turning voluntary pledges into enforceable domestic law the way we have, and to support serious investment in carbon removal and storage as a necessary complement to emissions cuts, not a substitute for them. We continue to expand offshore wind and industrial decarbonization even as a nation that sits below sea level and has the most to lose from delay. We recognize that our own targets still lean on carbon removal technology that does not yet exist at scale, and that critics argue we are counting on future solutions to cover for insufficient cuts today, and we bring that tension honestly into this room.",
      },
      {
        country: "China",
        speech:
          "The People's Republic of China has committed to peaking carbon emissions before 2030 and reaching carbon neutrality before 2060, and under our current five-year plan we are cutting carbon intensity per unit of GDP by 17 percent and raising non-fossil energy to a quarter of our total consumption. We call on this committee to recognize that a still-developing country of our size and population cannot decarbonize on the same timeline as nations that industrialized a century ago, and we ask for continued technology-sharing and financing support rather than pressure to abandon growth outright. Our renewable energy build-out is now the largest in the world, and we intend for it to be the engine of our transition rather than a symbolic gesture. We are aware that we also approved the largest wave of new coal power construction in a decade over the same period, and that critics see this as evidence our transition is additive rather than a genuine replacement, and we are prepared to address that contradiction directly.",
      },
      {
        country: "Brazil",
        speech:
          "Brazil proudly hosted COP30 in Bel\u00e9m, the gateway to the Amazon, and continues to campaign internationally for stronger climate cooperation and finance for the Global South. We call on this committee to recognize that standing forests are among the most effective and least expensive climate solutions available, and to direct real financing toward the nations and Indigenous communities that protect them, rather than treating forest protection as an obstacle to development. We remain committed to reducing Amazon deforestation as a central pillar of our climate strategy. We recognize that only days after we hosted the world for COP30, our own National Congress voted to weaken Amazon environmental safeguards, allowing projects to proceed with less environmental scrutiny and narrowing consultation requirements for Indigenous communities, a decision that international observers have called a step backward rather than modernization, and we bring that contradiction honestly into this committee.",
      },
      {
        country: "India",
        speech:
          "India reached fifty percent non-fossil fuel electricity capacity five years ahead of our own schedule, and our newly updated national climate pledge targets a forty-seven percent cut in emissions intensity by 2035 and sixty percent non-fossil capacity, alongside a major expansion of our forest carbon sinks. We call on this committee to judge climate ambition by the scale of transformation underway, not only by per-capita historical emissions comparisons that ignore how recently our economy has industrialized, and to direct climate finance toward countries proving that rapid clean energy growth is achievable. We are proud that our renewable capacity additions in 2025 were nearly double the previous year's pace. We recognize that we also added more new coal capacity this past year than in any year in over a decade, with tens of gigawatts more under construction, and that critics warn this locks in emissions for decades to come, and we are prepared to answer for that tension directly.",
      },
      {
        country: "Nigeria",
        speech:
          "Nigeria's updated climate pledge targets a thirty-two percent cut in emissions by 2035, and we have committed to ending routine gas flaring as part of that plan, redirecting captured gas toward domestic power generation instead of burning it off. We call on this committee to recognize that a nation with over ninety million people lacking reliable electricity cannot be asked to leave affordable energy sources on the table while it builds out renewable capacity, and to support blended, realistic transition pathways rather than a single global timeline applied to every economy equally. We are scaling gas-fired power specifically as what we consider a cleaner bridge away from diesel generators and flared gas. We recognize that international analysts have warned this strategy risks stranding assets or locking us into new fossil fuel dependency for decades, and that Nigeria has been through a resource-driven economic disappointment before with oil, and we take that warning seriously as we defend this plan before this committee.",
      },
    ],
  },
  {
    id: "sdg6",
    name: "SDG 6: Clean Water and Sanitation",
    description: "Ensure availability and sustainable management of water and sanitation for all.",
    delegates: [
      {
        country: "United States",
        speech:
          "The United States operates one of the most extensive drinking water systems in the world, built on the Safe Drinking Water Act, though our regulatory approach to newly identified contaminants continues to evolve as science and enforcement capacity develop. We call on this committee to prioritize water infrastructure investment and realistic implementation timelines over standards that outpace the treatment technology available to smaller utilities. Federal funding remains available to help water systems adopt new filtration methods as they come online. We recognize that our recent decision to delay enforcement of drinking-water limits on several PFAS \"forever chemicals\" has drawn sharp criticism from public health advocates who argue it prioritizes industry cost concerns over the safety of tap water, and we come to this committee prepared to hear that criticism directly.",
      },
      {
        country: "Philippines",
        speech:
          "The Philippines is an archipelago surrounded by water yet still faces serious gaps in safe water and sanitation access, a contradiction our own officials describe as facing too much water, too little water, and water that is too polluted, often within the same region. With World Bank support, we are investing roughly 250 million dollars to expand water systems, reduce water lost to leaks, and upgrade sanitation and waste management in some of our most underserved provinces, including areas in Bohol, Siargao, and the Bangsamoro region. We ask this committee to support continued international financing for climate-resilient water infrastructure in archipelagic and island nations like ours, where typhoons and flooding regularly damage the systems we build. We acknowledge that the communities with the lowest access to clean water in our country are also among our most vulnerable, and that progress has been slower there than anywhere else, and we bring that responsibility into this room rather than away from it.",
      },
      {
        country: "Netherlands",
        speech:
          "The Kingdom of the Netherlands is globally recognized for keeping our taps safe despite sitting downstream of much of Western Europe's water, but our surface water tells a very different story: independent rankings place us at the bottom of the European Union for water quality, with only a small fraction of our waters meeting ecological standards. We call on this committee to treat agricultural runoff and industrial discharge as a shared transboundary problem, since much of what reaches our rivers originates upstream in neighboring countries, and to support coordinated European-level enforcement rather than leaving each nation to manage its own downstream consequences alone. We are re-evaluating discharge permits for dozens of major industrial facilities and tightening rules on fertilizer use as a first step. We recognize that a significant share of our own water pollution comes from our own agricultural sector, particularly nutrient and manure runoff that has built up for decades, and that we may face financial penalties from the European Union if we fail to improve by 2027, and we accept that this is, in real part, a problem of our own making.",
      },
      {
        country: "China",
        speech:
          "The People's Republic of China has built one of the most extensive water-protection legal frameworks in the world, including dedicated laws on water pollution prevention and marine environmental protection, and a major rehabilitation plan targeting polluting industries along the Yangtze River. Our South-to-North Water Transfer Project remains one of the largest water infrastructure undertakings ever attempted, moving water at massive scale from the Yangtze basin to serve our arid northern provinces and cities. We call on this committee to recognize large-scale infrastructure investment as a legitimate and necessary tool for water security, particularly for nations facing severe geographic imbalances between water supply and population. We are aware that a project of this scale carries real costs, including the displacement of communities and disruption to ecosystems in the regions the water is drawn from, and that critics argue those costs have not been fully acknowledged or compensated, and we come to this committee ready to discuss them honestly.",
      },
      {
        country: "Brazil",
        speech:
          "Brazil's basic sanitation legal framework, our Marco Legal do Saneamento, sets a 2033 deadline for ninety-nine percent water access and ninety percent sewage collection nationwide, backed by real financial penalties for municipalities that fall behind. We call on this committee to support results-based financing models like ours, which tie infrastructure funding directly to enforceable national targets rather than voluntary commitments. Roughly eighty-five percent of Brazilians now receive treated drinking water, real progress from a decade ago. We recognize that only about half of our collected sewage actually receives treatment before discharge, that rural households remain far behind urban ones in access to piped water, and that our North and Northeast regions lag dramatically behind the rest of the country, with waterborne illness still driving well over a hundred thousand hospitalizations a year, and we bring that unfinished work honestly into this room.",
      },
      {
        country: "India",
        speech:
          "India's Jal Jeevan Mission has raised functional rural tap water connections from under seventeen percent to over eighty-two percent of households in under seven years, one of the fastest rural water infrastructure expansions attempted anywhere, and our government has committed nearly nine lakh crore rupees to complete universal coverage by 2028. We call on this committee to recognize decentralized, community-managed water infrastructure as a legitimate and scalable model for other large developing nations to study, not only centralized utility systems. We continue to guarantee a minimum daily water standard to every household we connect. We recognize that several of our largest states still lag well behind the national average, that long-term maintenance depends on inconsistent user fee collection across different regions, and that a share of our rural connections still face real questions about long-term sustainability, and we come to this committee aware of how much work remains beneath the headline number.",
      },
      {
        country: "Nigeria",
        speech:
          "Nigeria has worked to raise basic drinking water access to roughly seventy percent of our population and has committed to ending open defecation nationwide, a goal that has proven more difficult to reach on schedule than our government first hoped. We call on this committee to support international financing specifically for household sanitation and handwashing infrastructure in rapidly growing populations, where access has struggled to keep pace with population growth rather than falling behind through neglect alone. We continue to expand rural water, sanitation, and hygiene programs nationwide. We recognize that an estimated forty-six million of our own citizens still practice open defecation, that roughly a third of the water Nigerians drink remains contaminated, and that the average Nigerian still receives well under the water each day that international standards recommend, and we bring these numbers into this room rather than around them.",
      },
    ],
  },
  {
    id: "sdg7",
    name: "SDG 7: Affordable and Clean Energy",
    description: "Ensure access to affordable, reliable, sustainable, and modern energy for all.",
    delegates: [
      {
        country: "United States",
        speech:
          "The United States is pursuing what our government calls energy dominance, expanding oil, gas, and coal production, reopening federal lands including the Arctic National Wildlife Refuge to drilling, and pursuing a fourfold expansion of nuclear power capacity by 2050 through faster regulatory approval. We call on this committee to affirm that energy security and affordability are legitimate national priorities alongside emissions goals, and that no nation should be pressured into a single preferred energy mix. We believe a diversified portfolio, including nuclear, natural gas, and continued innovation, offers a more reliable path to affordable power than rapid renewable mandates alone. We recognize that our own recent legislation curtails tax credits for solar, wind, and hydrogen that had been expanding rapidly under the previous administration, and that this reversal has drawn criticism from clean energy advocates and international partners who see it as a retreat at a critical moment, and we are prepared to defend that trade-off before this committee.",
      },
      {
        country: "Philippines",
        speech:
          "The Philippines has set a national target of more than 40 percent renewable energy by 2030 and 50 percent by 2040, and international rankings now place us among the most attractive emerging markets for renewable investment worldwide. Through auction programs and new wind and solar projects reaching the grid, we are proving that an archipelago with strong sun and wind resources can build real capacity quickly. We ask this committee to prioritize international investment in transmission and battery storage infrastructure, since our grid, spread across thousands of islands, remains the single biggest constraint on how fast we can scale renewables. We recognize that our power supply is still nearly 60 percent dependent on coal today, and that we recently had to revoke dozens of renewable energy contracts covering thousands of megawatts after developers failed to deliver on their commitments, and we bring that gap between ambition and execution honestly into this room.",
      },
      {
        country: "Netherlands",
        speech:
          "The Kingdom of the Netherlands has built one of the most advanced offshore wind industries in the world across the North Sea, and we continue to expand that capacity as a cornerstone of our clean energy transition. We call on this committee to support financing models that make clean energy commercially viable, since we have learned firsthand that ambition alone does not attract developers when project costs rise faster than expected. We believe predictable subsidy frameworks, paired with realistic auction targets, deliver more actual clean power than aggressive headline goals that go unbid. We recognize that we were recently forced to scale back our own 2026 offshore wind auction from two large projects to one after a previous zero-subsidy tender attracted no bidders at all, and that this retreat has raised real questions about whether Europe's offshore wind ambitions are colliding with economic reality, and we accept this committee's scrutiny of that record.",
      },
      {
        country: "China",
        speech:
          "The People's Republic of China now operates the largest renewable energy fleet in the world, with wind and solar capacity that surpassed our own thermal power capacity for the first time last year, driving the first decline in our power-sector emissions in over a decade. We call on this committee to recognize the scale of that achievement and to support continued technology and manufacturing cooperation, since our supply chains have made clean energy affordable for markets far beyond our own borders. We believe a nation of our size cannot transition instantly, and that maintaining domestic coal capacity during this transition is a matter of energy security rather than a rejection of clean energy. We recognize that we also approved the largest wave of new coal power construction in a decade over this same period, and that critics argue coal is supplementing our renewable growth rather than being replaced by it, and we are prepared to answer that criticism directly.",
      },
      {
        country: "Brazil",
        speech:
          "Brazil operates one of the cleanest large electricity grids in the world, with renewable sources supplying roughly eighty-five percent of our installed capacity, anchored by hydropower and increasingly by wind and solar, alongside a biofuels and ethanol industry that has decarbonized our transportation sector for decades longer than most nations have even discussed it. We call on this committee to treat hydropower and biofuels as legitimate, proven clean energy pathways deserving of the same international investment and recognition as wind and solar. We continue to expand our renewable capacity and are investing billions in sustainable aviation fuel and biogas through our national energy company. We recognize that our grid's reliability now depends heavily on transmission infrastructure we have not built fast enough, that a meaningful share of our solar power is wasted through curtailment at peak periods, and that drought years still force us back toward fossil fuel backup power, and we accept this committee's scrutiny of that vulnerability.",
      },
      {
        country: "India",
        speech:
          "India crossed fifty percent non-fossil fuel electricity capacity five years ahead of our own target, added more renewable capacity in 2025 than in any year in our history, and helped found the International Solar Alliance to bring solar deployment to other developing nations. We call on this committee to recognize that a nation of our scale and population density can lead the world in absolute renewable capacity while still meeting the electricity needs of over a billion people, and to support manufacturing and technology partnerships that let other developing nations follow a similar path. Our solar capacity alone surpassed one hundred thirty gigawatts this year. We recognize that despite this renewable capacity growth, coal still generates roughly sixty percent of the electricity actually used in our country due to grid integration limits, and that our own government projects coal capacity could nearly double again by 2047, and we are prepared to explain that contradiction to this committee directly.",
      },
      {
        country: "Nigeria",
        speech:
          "Nigeria's off-grid solar sector installed more than eight hundred megawatts of new solar capacity last year alone, a market now growing faster than almost anywhere else in Africa, as businesses and households replace expensive diesel generators with solar systems and mini-grids. We call on this committee to recognize that for a country where roughly ninety million people still lack reliable electricity access, off-grid and mini-grid solar is not a secondary solution but often the fastest and most realistic path to real electricity access, and to support continued international investment in that model rather than only centralized grid extension. Our energy regulator has expanded mini-grid capacity thresholds specifically to accelerate this growth. We recognize that natural gas still plays and is planned to keep playing a large and growing role in our national power strategy, one that critics argue risks locking us into fossil fuel dependence for decades, and we bring that tension honestly into this committee.",
      },
    ],
  },
  {
    id: "sdg12",
    name: "SDG 12: Responsible Consumption and Production",
    description: "Ensure sustainable consumption and production patterns.",
    delegates: [
      {
        country: "United States",
        speech:
          "The United States remains one of the largest producers of both consumer goods and municipal waste in the world, and our Environmental Protection Agency published a national strategy in 2024 aimed at preventing plastic pollution across the full lifecycle of production and disposal. We call on this committee to favor industry-led, market-based recycling partnerships over binding international consumption targets, trusting innovation and voluntary commitments like our national plastics pact to drive real reductions. We continue to invest in advanced recycling technology as an alternative to simply producing less. We recognize that our own national plastic pollution strategy is currently under review by our government with its future direction uncertain, and that our per-person waste generation remains among the highest of any nation on Earth, and we come to this committee aware of that contradiction.",
      },
      {
        country: "Philippines",
        speech:
          "The Philippines has enacted one of the more ambitious extended producer responsibility laws in the region, requiring our largest companies to recover a rising share of the plastic packaging they sell, reaching 80 percent by 2028, backed by real financial penalties for noncompliance. We call on this committee to support similar producer-responsibility frameworks globally, and to help fund the enforcement and auditing capacity that developing nations need to make these laws more than words on paper. We are proud to report that our largest companies have already surpassed their 2025 recovery targets under this law. We recognize that environmental groups in our own country have criticized the law for letting large companies keep producing plastic as long as they recover it later, rather than requiring reduction or an outright ban on single-use plastics, and we bring that unresolved debate into this committee rather than pretending it is settled.",
      },
      {
        country: "Netherlands",
        speech:
          "The Kingdom of the Netherlands has set a national goal of a fully circular economy by 2050, organized around reducing consumption, substituting sustainable materials, extending product lifespans, and improving recycling across every sector of our economy. We call on this committee to support coordinated international standards for product design and material flows, since the supply chains that create waste do not respect national borders and no single country can close the loop alone. We participate actively in international circular economy partnerships to help build that cooperation. We recognize that 2050 is still decades away, that most of the hard transformation is still ahead of us, and that our own progress depends heavily on international cooperation we do not fully control, and we accept this committee's scrutiny of how much of that goal remains aspiration rather than achievement.",
      },
      {
        country: "China",
        speech:
          "The People's Republic of China fundamentally reshaped the global waste trade in 2018 when we banned the import of foreign plastic and recyclable waste, ending our position as the world's largest importer of other countries' recycling and forcing exporting nations to rebuild their own domestic recycling capacity. We call on this committee to recognize that no nation should be expected to serve as the processing ground for the world's waste, and that wealthier exporting nations bear primary responsibility for managing what their own consumption produces. We continue to build a domestic circular economy policy framework suited to our own manufacturing base, and we are now selectively reopening channels for higher-grade recycled materials on our own terms. We recognize that our ban, while environmentally justified at home, contributed to a global recycling disruption that shifted much of that waste toward other developing countries instead of solving the underlying problem, and we come to this committee ready to discuss that unintended consequence honestly.",
      },
      {
        country: "Brazil",
        speech:
          "Brazil now requires companies to establish reverse logistics systems for plastic packaging under a new national decree, phasing in recovery targets that rise from thirty-two percent by 2026 toward fifty percent recovery and forty percent recycled content by 2040. We call on this committee to support producer-responsibility frameworks like ours as a serious middle path between doing nothing and banning products outright, one that keeps industry accountable for the materials it puts into the market. We are building the reporting infrastructure to track compliance transparently as this system matures. We recognize that our own agribusiness supply chains, particularly cattle and soy linked to Amazon deforestation, remain a major unresolved consumption and production challenge that this packaging decree does not touch at all, and we bring that larger, harder problem into this room rather than pretending our work here is complete.",
      },
      {
        country: "India",
        speech:
          "India has recycled over twenty million tonnes of plastic since 2022 under our Extended Producer Responsibility framework, and our newly amended Plastic Waste Management Rules raise recycled-content requirements across every category of plastic packaging while introducing a tradable credits system so companies exceeding their targets can support those still catching up. We call on this committee to support flexible, market-based compliance tools like tradable recycling credits as a way to keep large and small producers alike moving toward the same targets. We continue to tighten these rules as implementation experience reveals what still needs fixing. We recognize that regulators have identified hundreds of thousands of fraudulent compliance certificates within this same system, and that our annual plastic waste generation continues to grow even as our recycling capacity does, and we come to this committee aware that enforcement, not just ambition, is where this policy is still being tested.",
      },
      {
        country: "Nigeria",
        speech:
          "Nigeria has introduced new national Plastic Waste Control Regulations requiring producers and importers to take responsibility for their products for their full lifecycle, including new recycled-content minimums for plastic bottles and thickness rules meant to phase out the thinnest, most polluting plastic bags. We call on this committee to support enforcement capacity-building for developing nations adopting producer-responsibility laws like ours, since a regulation without the resources to enforce it changes very little on the ground. We are building the registration and compliance system needed to make this more than a paper policy. We recognize that we generate an estimated two and a half million tonnes of plastic waste every year, most of it still ending up in our waterways and communities rather than in any formal recovery system, and that our own officials have said plainly that a regulation without enforcement is merely a wish, and we bring that blunt admission into this committee ourselves.",
      },
    ],
  },
];

const COMMITTEE_COUNTRIES = COMMITTEE_TOPICS[0].delegates.map((delegate) => delegate.country);

// How a delegate's country is shown anywhere their identity appears
// (the delegate list, vote rows, the Queue Order panel, discussion
// messages): just the country name for an AI Delegate or a human seat
// nobody has typed a name for yet, or "COUNTRY(Name)" once they have --
// see claimDelegateSeat below, where that name gets set.
function formatDelegateLabel(country, delegateNames) {
  const name = delegateNames?.[country];
  return name ? `${country}(${name})` : country;
}

// Looks up one topic's full record (name, description, delegate speeches)
// by its id. Returns null if the id doesn't match any known topic.
function getTopic(topicId) {
  return COMMITTEE_TOPICS.find((topic) => topic.id === topicId) ?? null;
}

// Picks a random topic id, optionally leaving one out -- used to
// propose a first topic for a brand-new committee session.
function randomTopicId(excludeId) {
  const pool = COMMITTEE_TOPICS.filter((topic) => topic.id !== excludeId);
  const choices = pool.length > 0 ? pool : COMMITTEE_TOPICS;
  return choices[Math.floor(Math.random() * choices.length)].id;
}

// The MUN procedure this committee follows, in order -- the shared
// 7-stage flow used across every site on this team's project (Conference
// Setup through Conference Results). Most transitions are chair-driven
// (see chair.js); only three phases actually hold a delegate vote:
// Conference Setup (confirming who's present), Motion Voting, and the
// final Sign/Not Sign/Abstain vote inside Resolution / Final Vote.
const COMMITTEE_PHASES = [
  "Conference Setup",
  "Opening Speeches",
  "Motion Raising",
  "Motion Voting",
  "Caucus / Debate",
  "Resolution / Final Vote",
  "Conference Results",
];

// Fixed positions of the phases the code needs to treat specially.
const SETUP_PHASE_INDEX = 0;
const OPENING_SPEECHES_PHASE_INDEX = 1;
const MOTION_RAISING_PHASE_INDEX = 2;
const MOTION_VOTING_PHASE_INDEX = 3;
const CAUCUS_DEBATE_PHASE_INDEX = 4;
const RESOLUTION_VOTE_PHASE_INDEX = 5;
const CONFERENCE_RESULTS_PHASE_INDEX = COMMITTEE_PHASES.length - 1;

// The two motions a delegate can raise during Motion Raising -- whichever
// one passes Motion Voting decides what kind of debate Caucus / Debate
// becomes.
const MOTION_TYPES = {
  moderated_caucus: "Motion for a Moderated Caucus",
  unmoderated_caucus: "Motion for an Unmoderated Caucus",
};

// Conference Setup is actually three small steps in order, tracked by
// this field (meaningful only while phaseIndex is SETUP_PHASE_INDEX,
// but always present -- see isFinalSigningVote's comment above for why
// every field has to stay valid on every write regardless of phase):
//   roll_call      -- the presence-check vote delegates see first.
//   awaiting_start -- presence confirmed; waiting on the Chair to click
//                     "Start Conference & Give Instructions".
//   goal_poll      -- the welcome message is out and delegates are
//                     voting on whether they agree with the chosen
//                     goal/topic. Passing moves on to Opening Speeches;
//                     failing just waits for the Chair to pick a
//                     different topic, which reopens this same poll.
const SETUP_STAGE = {
  ROLL_CALL: "roll_call",
  AWAITING_START: "awaiting_start",
  GOAL_POLL: "goal_poll",
};

// Points at the one Firestore document that counts every conference
// this site has ever started, across every committee session -- unlike
// everything in committee/state, this is never reset or touched by
// Reset Committee Session, since the whole point is a running total.
const conferenceStatsRef = doc(db, "appState", "conferenceStats");

// The exact welcome message delegates see once the Chair clicks "Start
// Conference & Give Instructions" -- built in one place so the Chair's
// own preview (chair.js) and the delegate page (committee.js) can never
// end up saying something different.
function conferenceWelcomeMessage(conferenceNumber) {
  return (
    `Welcome to the Bridge MUN Conference #${conferenceNumber}. ` +
    "There will be a poll on the agreement of the goal."
  );
}

// Chair-only: bumps the running conference count and, in the same
// transaction, writes that new number into this session's
// committee/state and opens the goal-agreement poll -- the welcome
// message and the poll go out in one click. Does nothing if Conference
// Setup isn't actually waiting on this (the button is disabled then
// anyway, but phase changes can land mid-click). See chair.js, where
// the one button that calls this lives.
async function startConferenceAndAnnounce() {
  const conferenceNumber = await runTransaction(db, async (transaction) => {
    const [statsSnapshot, stateSnapshot] = await Promise.all([
      transaction.get(conferenceStatsRef),
      transaction.get(committeeStateRef),
    ]);
    if (!stateSnapshot.exists()) {
      return null;
    }

    const data = stateSnapshot.data();
    if (data.setupStage !== SETUP_STAGE.AWAITING_START) {
      return null;
    }

    const previousTotal = statsSnapshot.exists() ? statsSnapshot.data().totalConferences ?? 0 : 0;
    const nextNumber = previousTotal + 1;

    transaction.set(conferenceStatsRef, {
      totalConferences: nextNumber,
      updatedAt: serverTimestamp(),
    });
    transaction.update(committeeStateRef, {
      setupStage: SETUP_STAGE.GOAL_POLL,
      conferenceNumber: nextNumber,
      votes: initialVotesForPhase(data.delegateRoles, SETUP_PHASE_INDEX),
      updatedAt: serverTimestamp(),
    });

    return nextNumber;
  });

  if (conferenceNumber != null) {
    logActivity(
      "conference_started",
      null,
      `The Chair started Conference #${conferenceNumber} and opened the goal-agreement poll.`,
    );
  }

  return conferenceNumber;
}

// Finds the next country, starting at startIndex, whose delegate is
// human -- AI Delegates are skipped over automatically since nobody
// needs to click anything on their behalf. Returns
// COMMITTEE_COUNTRIES.length once every human delegate has already had
// a turn, which the UI reads as "nobody is speaking anymore."
function findNextHumanSpeakerIndex(delegateRoles, startIndex) {
  for (let index = startIndex; index < COMMITTEE_COUNTRIES.length; index += 1) {
    if (delegateRoles[COMMITTEE_COUNTRIES[index]] === "human") {
      return index;
    }
  }
  return COMMITTEE_COUNTRIES.length;
}

// More than half of all delegates must land on the passing choice to
// succeed (e.g. 4 of 7). Every vote is Yes/No except the final
// Resolution / Final Vote vote, which is Sign/Not Sign/Abstain instead
// -- abstaining is allowed there (unlike every earlier vote) but still
// doesn't count toward the majority needed to actually sign.
const VOTE_THRESHOLD = Math.floor(COMMITTEE_COUNTRIES.length / 2) + 1;

const VOTE_CHOICE_LABELS = {
  yes: "Yes",
  no: "No",
  sign: "Sign",
  not_sign: "Not Sign",
  abstain: "Abstain",
};

const VOTE_CHOICE_BUTTON_CLASSES = {
  yes: "vote-yes",
  no: "vote-no",
  sign: "vote-yes",
  not_sign: "vote-no",
  abstain: "vote-abstain",
};

// True only for the one vote inside Resolution / Final Vote that's
// actually the final Sign/Not Sign/Abstain vote -- the earlier
// "drafting" half of that same phase (see subStage) has no vote at all.
function isFinalSigningVote(phaseIndex, subStage) {
  return phaseIndex === RESOLUTION_VOTE_PHASE_INDEX && subStage === "voting";
}

// Decides whether the votes cast so far already add up to a majority for
// passingValue ("yes" for most votes, "sign" for the final vote), have
// already made that majority impossible no matter how any remaining
// (still-blank) votes land, or are still undecided either way.
function voteOutcome(votes, passingValue) {
  const passCount = COMMITTEE_COUNTRIES.filter((country) => votes[country] === passingValue).length;
  const pendingCount = COMMITTEE_COUNTRIES.filter((country) => votes[country] === null).length;
  const maxPossiblePass = passCount + pendingCount;

  if (passCount >= VOTE_THRESHOLD) {
    return "passed";
  }
  if (maxPossiblePass < VOTE_THRESHOLD) {
    return "failed";
  }
  return "pending";
}

// Every conference anyone creates gets its own random 6-digit code
// (like a Kahoot game PIN), owned by whichever signed-in Google account
// created it -- any number of people can each be running their own
// conference at once. Firestore layout:
//   sessions/{code}/committee/state       -- same shape committee/state
//                                             used to be, plus ownerUid
//                                             (the creator's Google uid)
//   sessions/{code}/committee/resolution  -- same shape committee/
//                                             resolution used to be
//   sessions/{code}/committeeMessages/*   -- same shape as before
//   sessions/{code}/activityLog/*         -- same shape as before

// Which session this browser tab is looking at, and the two document
// references everything below reads and writes -- all three start out
// unknown. my-page.js, chair.js, and committee.js must resolve a code
// (see createOwnedConference/joinSessionByCode below) before any of the
// rest of this module's Firestore calls will work.
let activeSessionCode = null;
export let committeeStateRef = null;
export let committeeResolutionRef = null;
export let latestCommitteeState = null;

const RESOLUTION_MAX_LENGTH = 20000;

// Delegates can edit the shared draft resolution starting in Caucus /
// Debate, and keep editing into the "drafting" half of Resolution /
// Final Vote (see subStage) -- locked the moment that phase's subStage
// flips to "voting", so delegates can review exactly what they're
// voting to sign without being able to change it mid-vote.
const RESOLUTION_EDITABLE_START_INDEX = CAUCUS_DEBATE_PHASE_INDEX;

function isResolutionEditablePhase(phaseIndex, subStage) {
  return phaseIndex === CAUCUS_DEBATE_PHASE_INDEX || (phaseIndex === RESOLUTION_VOTE_PHASE_INDEX && subStage === "drafting");
}

// Randomly splits the seven delegates into two AI Delegates and five
// Human Delegates. Called once per committee session (see
// createOwnedConference). Kept at exactly two AI Delegates regardless of
// the total delegate count, since real AI decision-making costs money and
// keeping it to a fixed, free auto-vote is what keeps the site accessible.
function randomDelegateRoles() {
  const shuffled = [...COMMITTEE_COUNTRIES].sort(() => Math.random() - 0.5);
  const aiCountries = new Set(shuffled.slice(0, 2));
  const roles = {};

  COMMITTEE_COUNTRIES.forEach((country) => {
    roles[country] = aiCountries.has(country) ? "ai" : "human";
  });

  return roles;
}

// Starts a fresh vote: AI Delegates auto-vote immediately (they have no
// real person to click a button for them, and keeping this a fixed
// automatic choice rather than an actual AI decision keeps the site free
// to run) -- Sign on the final Resolution / Final Vote vote, Yes
// everywhere else (including "Present" during Conference Setup and "In
// Favor" during Motion Voting). Human Delegates always start blank.
// subStage only matters for Resolution / Final Vote, where it tells this
// apart from that same phase's non-voted "drafting" half.
function initialVotesForPhase(delegateRoles, phaseIndex, subStage) {
  const aiChoice = isFinalSigningVote(phaseIndex, subStage) ? "sign" : "yes";
  const votes = {};
  COMMITTEE_COUNTRIES.forEach((country) => {
    votes[country] = delegateRoles[country] === "ai" ? aiChoice : null;
  });
  return votes;
}

// Silently records one event to the shared activity log in Firestore, for
// later review only -- nothing on the page itself displays this log.
// Never blocks or breaks the action it's attached to if logging fails.
function logActivity(type, country, detail) {
  ensureAnonymousUser()
    .then((user) =>
      addDoc(getActivityLogCollection(), {
        type,
        country: country ?? null,
        detail,
        createdAt: serverTimestamp(),
      }),
    )
    .catch((error) => console.error(`Unable to log activity (${type}):`, error));
}

// Repairs an older committee session that predates some field this
// module now expects -- does nothing if the session is already
// up to date. Unlike before, this never CREATES a session: every
// conference now starts life through createOwnedConference instead
// (called once, by whoever creates it), so a code that doesn't already
// resolve to a real document here is just a dead code, not something
// to silently fill in.
async function ensureCommitteeState() {
  await ensureAnonymousUser();
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);

    if (snapshot.exists()) {
      const data = snapshot.data();
      // Repairs a committee session that was created before delegates
      // were assigned their own country -- without this, an older
      // session's document simply has no delegateAssignments field at
      // all, which would make every country look "unclaimed" forever.
      const missingAssignments = data.delegateAssignments == null || typeof data.delegateAssignments !== "object";
      // Repairs a committee session created before delegates could
      // type their own display name -- an older session's document
      // simply has no delegateNames field at all.
      const missingDelegateNames = data.delegateNames == null || typeof data.delegateNames !== "object";
      // Repairs a committee session created before the Start-Conference
      // roster lock / AI-auto-advance feature existed -- an older
      // session's document simply has none of these three fields.
      const missingRosterLocked = typeof data.rosterLocked !== "boolean";
      const missingChairIsAi = typeof data.chairIsAi !== "boolean";
      const missingTopicConfirmed = typeof data.topicConfirmedByChair !== "boolean";
      // Repairs a committee session created before the Proceed /
      // readiness-check feature existed -- an older session's document
      // simply has neither of these two fields.
      const missingReadyCountries = data.readyCountries == null || typeof data.readyCountries !== "object";
      const missingReadyCheckOpen = typeof data.readyCheckOpen !== "boolean";
      // Repairs a committee session created before motions, the
      // Resolution / Final Vote drafting/voting split, or yield
      // requests existed -- without this, an older session's document
      // is simply missing these fields.
      const missingSpeakerIndex = typeof data.currentSpeakerIndex !== "number";
      const missingSubStage = typeof data.subStage !== "string";
      const missingRaisedMotion = !("raisedMotion" in data);
      const missingYieldRequest = !("pendingYieldRequest" in data);
      // Repairs a committee session created before Conference Setup
      // was split into roll call / awaiting-start / goal-poll steps --
      // an older session's document simply has no setupStage or
      // conferenceNumber field at all.
      const missingSetupStage = typeof data.setupStage !== "string";
      const missingConferenceNumber = !("conferenceNumber" in data);
      if (
        missingAssignments ||
        missingDelegateNames ||
        missingSpeakerIndex ||
        missingSubStage ||
        missingRaisedMotion ||
        missingYieldRequest ||
        missingSetupStage ||
        missingConferenceNumber ||
        missingRosterLocked ||
        missingChairIsAi ||
        missingTopicConfirmed ||
        missingReadyCountries ||
        missingReadyCheckOpen
      ) {
        transaction.update(committeeStateRef, {
          ...(missingAssignments ? { delegateAssignments: {} } : {}),
          ...(missingDelegateNames ? { delegateNames: {} } : {}),
          ...(missingRosterLocked ? { rosterLocked: false } : {}),
          ...(missingChairIsAi ? { chairIsAi: false } : {}),
          ...(missingTopicConfirmed ? { topicConfirmedByChair: false } : {}),
          ...(missingReadyCountries ? { readyCountries: {} } : {}),
          ...(missingReadyCheckOpen ? { readyCheckOpen: false } : {}),
          ...(missingSpeakerIndex ? { currentSpeakerIndex: 0 } : {}),
          ...(missingSubStage ? { subStage: "drafting" } : {}),
          ...(missingRaisedMotion ? { raisedMotion: null } : {}),
          ...(missingYieldRequest ? { pendingYieldRequest: null } : {}),
          ...(missingSetupStage ? { setupStage: SETUP_STAGE.ROLL_CALL } : {}),
          ...(missingConferenceNumber ? { conferenceNumber: null } : {}),
          updatedAt: serverTimestamp(),
        });
      }
      return;
    }

    // Nothing to repair -- there's no document here at all, and (see
    // above) this function no longer creates one.
  });
}

// Starts a brand-new committee session: a fresh random AI/Human split, a
// freshly proposed topic, back to Conference Setup, and every vote
// cleared. Chair-only -- see chair.js, where the one button that calls
// this lives (the chair dashboard is Google-auth gated, so this can't
// be reached by a delegate through the UI).
// Points every shared reference above at one specific session's data --
// committee.js and chair.js each call this once they know which code
// they're working with, and every function in this module that reads
// committeeStateRef/committeeResolutionRef after that automatically
// talks to the right session (the same live-binding trick
// setLatestCommitteeState uses for latestCommitteeState).
function setActiveSessionCode(code) {
  activeSessionCode = code;
  committeeStateRef = doc(db, "sessions", code, "committee", "state");
  committeeResolutionRef = doc(db, "sessions", code, "committee", "resolution");
}

// Built fresh from activeSessionCode on every call, rather than cached
// like the two refs above -- committee.js only ever uses these as an
// input to query()/addDoc(), never holds onto them.
function getCommitteeMessagesCollection() {
  return collection(db, "sessions", activeSessionCode, "committeeMessages");
}

function getActivityLogCollection() {
  return collection(db, "sessions", activeSessionCode, "activityLog");
}

// Makes a random six-digit meeting code (as a string, so a leading zero
// is kept) and checks it isn't already in use before handing it back --
// a collision is very unlikely across 900,000 possible codes, but worth
// guarding against instead of assuming.
async function generateUniqueSessionCode() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const existing = await getDoc(doc(db, "sessions", code, "committee", "state"));
    if (!existing.exists()) {
      return code;
    }
  }
  throw new Error("Could not generate a free meeting code -- please try again.");
}

// Creates a brand-new conference owned by the given Google uid: a
// fresh 6-digit code, a fresh random AI/Human split, a freshly proposed
// topic, starting at Conference Setup with every vote cleared. Used by
// my-page.js's Join button (the very first conference a signed-in user
// creates) and by chair.js's Reset Committee Session button (starting a
// new one under that same owner). Returns the new code so the caller
// can display or navigate to it right away.
async function createOwnedConference(ownerUid) {
  const code = await generateUniqueSessionCode();
  const delegateRoles = randomDelegateRoles();
  const topicId = randomTopicId(null);
  const newStateRef = doc(db, "sessions", code, "committee", "state");

  await setDoc(newStateRef, {
    ownerUid,
    phaseIndex: SETUP_PHASE_INDEX,
    delegateRoles,
    votes: initialVotesForPhase(delegateRoles, SETUP_PHASE_INDEX),
    topicId,
    rollCallVotes: null,
    raisedMotion: null,
    subStage: "drafting",
    pendingYieldRequest: null,
    setupStage: SETUP_STAGE.ROLL_CALL,
    conferenceNumber: null,
    // A brand-new session has nobody assigned to a country yet -- each
    // delegate who joins picks one of the human-run countries for
    // themselves, with a display name, when they join (see
    // claimDelegateSeat below).
    delegateAssignments: {},
    // The display name each delegate typed for themselves, keyed by
    // country (see claimDelegateSeat and formatDelegateLabel below).
    delegateNames: {},
    // Whether the Chair has clicked "Start Conference" on chair.html --
    // once true, no one can join as a delegate anymore (see
    // claimDelegateSeat below and chair.js's lockRosterAndStart), and
    // every human-run seat nobody claimed in time becomes AI-run.
    rosterLocked: false,
    // True only when the roster was locked with literally no one
    // having joined -- every delegate AND the Chair itself runs as AI
    // then, with chair.js auto-advancing the whole conference on its
    // own (see the AI-auto-advance driver there) once a topic is
    // confirmed.
    chairIsAi: false,
    // Set once the Chair has explicitly picked a topic (see chooseTopic
    // in chair.js) -- distinct from topicId, which starts out as a
    // random proposal nobody has actually chosen yet. chair.js's
    // AI-auto-advance driver waits for this before doing anything, so
    // "the user chooses the topic" always holds even in a fully-AI
    // conference.
    topicConfirmedByChair: false,
    // Which delegates have clicked "Proceed" / "I'm Ready" for the
    // CURRENT phase -- keyed by country, cleared back to {} every time
    // the phase actually changes (see the many transaction.update
    // calls below that reset it). In an AI-run conference (chairIsAi),
    // the AI-auto-advance driver waits for every human-run country to
    // appear here before moving on; in a human-chaired conference,
    // this is just what readyCheckOpen below collects for the Chair to
    // look at -- clicking it never advances anything by itself there.
    readyCountries: {},
    // Chair-only: true while a "poll for final check" the Chair opened
    // is waiting on delegate responses (see the new readiness-check
    // button in chair.js) -- purely informational, so the Chair can
    // see who's actually ready before clicking whichever existing
    // phase-advance button applies. Always ignored in an AI-run
    // conference, where delegates can click Proceed at any time
    // regardless of this flag.
    readyCheckOpen: false,
    // Unused until Caucus / Debate -- see castVote in committee.js,
    // which sets this properly once the committee actually gets there.
    currentSpeakerIndex: 0,
    updatedAt: serverTimestamp(),
  });

  setActiveSessionCode(code);

  const aiCountries = COMMITTEE_COUNTRIES.filter((country) => delegateRoles[country] === "ai").join(", ");
  logActivity(
    "session_reset",
    null,
    `A new committee session was created, starting from Conference Setup with a proposed topic: ${getTopic(topicId)?.name}. AI Delegates this session: ${aiCountries}.`,
  );

  return code;
}

// Delegate-only: checks a code a visitor typed in actually belongs to a
// real conference. On a match, switches every shared reference above
// over to that session and returns true; returns false if no such
// conference exists (wrong code, or the owner has since reset it).
async function joinSessionByCode(code) {
  const stateRef = doc(db, "sessions", code, "committee", "state");
  const snapshot = await getDoc(stateRef);
  if (!snapshot.exists()) {
    return false;
  }
  setActiveSessionCode(code);
  return true;
}

// Delegate-only: claims one specific, still-open human-run country for
// this visitor, remembering the display name they typed alongside it
// (e.g. "Ryan" for "United States" becomes "United States(Ryan)"
// everywhere -- see formatDelegateLabel above). Used by my-page.js
// and join-code.js once a visitor has picked both a country and typed
// their name. Returns the claimed country on success; throws with a
// short reason code ("not_found" | "not_available" | "taken")
// otherwise, which the caller turns into a plain-language message.
async function claimDelegateSeat(code, country, name) {
  const user = await ensureAnonymousUser();
  const trimmedName = (name ?? "").trim();
  const stateRef = doc(db, "sessions", code, "committee", "state");

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(stateRef);
    if (!snapshot.exists()) {
      throw new Error("not_found");
    }

    const data = snapshot.data();
    const assignments = { ...(data.delegateAssignments ?? {}) };

    // Already assigned -- a reload, or submitting this form twice --
    // so keep their existing country instead of claiming a second one.
    if (assignments[user.uid]) {
      return assignments[user.uid];
    }

    // The Chair has clicked "Start Conference" -- registration is
    // closed, no matter how the visitor got to this form (see
    // lockRosterAndStart below).
    if (data.rosterLocked) {
      throw new Error("locked");
    }

    if (data.delegateRoles?.[country] !== "human") {
      throw new Error("not_available");
    }

    const takenCountries = new Set(Object.values(assignments));
    if (takenCountries.has(country)) {
      throw new Error("taken");
    }

    const delegateNames = { ...(data.delegateNames ?? {}) };
    if (trimmedName) {
      delegateNames[country] = trimmedName;
    }

    transaction.update(stateRef, {
      [`delegateAssignments.${user.uid}`]: country,
      delegateNames,
      updatedAt: serverTimestamp(),
    });

    return country;
  });
}

// Moved here (originally lived only in committee.js) so chair.js can
// also call these directly -- needed for the AI-auto-advance driver in
// chair.js, which simulates an AI delegate casting a vote, raising a
// motion, or asking to yield by calling the exact same functions a real
// delegate's click would call, instead of duplicating this logic.
// Casts one Human Delegate's vote during whichever phase currently
// holds a vote -- Conference Setup's presence check, Motion Voting, or
// the final Sign/Not Sign/Abstain vote inside Resolution / Final Vote.
// If the votes cast so far add up to a majority, this same transaction
// advances the committee to wherever that vote leads next: Conference
// Setup -> Opening Speeches, Motion Voting -> Caucus / Debate (or back
// to Motion Raising if the motion failed instead), and the final vote
// -> Conference Results. Refuses to run during any other phase, so a
// stale button left over from a previous render can never cast an
// invalid vote -- done inside one transaction so it stays correct even
// if multiple visitors vote at the same moment.
export async function castVote(country, choice) {
  await ensureAnonymousUser();

  const result = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return null;
    }

    const data = snapshot.data();
    const onSetupVote =
      data.phaseIndex === SETUP_PHASE_INDEX &&
      (data.setupStage === SETUP_STAGE.ROLL_CALL || data.setupStage === SETUP_STAGE.GOAL_POLL);
    const votingNow =
      onSetupVote ||
      data.phaseIndex === MOTION_VOTING_PHASE_INDEX ||
      isFinalSigningVote(data.phaseIndex, data.subStage);
    if (!votingNow) {
      return null;
    }

    const votes = { ...data.votes, [country]: choice };
    const phaseName = COMMITTEE_PHASES[data.phaseIndex];
    const passingValue = isFinalSigningVote(data.phaseIndex, data.subStage) ? "sign" : "yes";
    const outcome = voteOutcome(votes, passingValue);

    // In an AI-run conference (chairIsAi), outside Conference Setup, a
    // vote's AI majority alone almost always already reaches the
    // threshold the instant the phase opens -- every AI country's
    // vote is pre-filled by initialVotesForPhase before any delegate
    // (human or AI) casts a single real vote here. Without this check,
    // Motion Voting and the final Sign/Not Sign/Abstain vote would
    // transition (and, on the display side, hide the vote buttons --
    // see renderCommitteeState in committee.js) before the one real
    // human delegate even gets a chance to look, let alone vote --
    // which is exactly the bug this guards against. Conference Setup's
    // roll call and goal-agreement poll stay exempt (neither branch
    // below checks this), matching the rule that those two stay fully
    // automatic even in an AI-run conference.
    const everyHumanHasVoted = COMMITTEE_COUNTRIES.filter((c) => data.delegateRoles[c] === "human").every(
      (c) => votes[c] != null,
    );
    const canActOnOutcome = !data.chairIsAi || everyHumanHasVoted;

    // The presence check passing: lock in the permanent Roll Call
    // Results record, then wait for the Chair to click "Start
    // Conference & Give Instructions" -- see startConferenceAndAnnounce
    // in committee-data.js for what happens after that.
    if (outcome === "passed" && data.phaseIndex === SETUP_PHASE_INDEX && data.setupStage === SETUP_STAGE.ROLL_CALL) {
      const rollCallVotes = {};
      COMMITTEE_COUNTRIES.forEach((country2) => {
        rollCallVotes[country2] = votes[country2] === "yes" ? "yes" : "no";
      });
      const votingCountries = COMMITTEE_COUNTRIES.filter((c) => rollCallVotes[c] === "yes");
      const notVotingCountries = COMMITTEE_COUNTRIES.filter((c) => rollCallVotes[c] === "no");

      transaction.update(committeeStateRef, {
        setupStage: SETUP_STAGE.AWAITING_START,
        rollCallVotes,
        updatedAt: serverTimestamp(),
      });
      return {
        phaseName,
        advancedTo: null,
        rollCallSummary:
          `Voting: ${votingCountries.join(", ") || "None"}. ` +
          `Not Voting: ${notVotingCountries.join(", ") || "None"}.`,
      };
    }

    // The goal-agreement poll passing (opened by the Chair's "Start
    // Conference & Give Instructions" button): move on to Opening
    // Speeches. Failing isn't handled here at all -- there's nothing
    // automatic to do, since recovering means the Chair picks a
    // different topic, which reopens this same poll (see chooseTopic
    // in chair.js).
    if (outcome === "passed" && data.phaseIndex === SETUP_PHASE_INDEX && data.setupStage === SETUP_STAGE.GOAL_POLL) {
      transaction.update(committeeStateRef, {
        phaseIndex: OPENING_SPEECHES_PHASE_INDEX,
        votes: initialVotesForPhase(data.delegateRoles, OPENING_SPEECHES_PHASE_INDEX),
        // Opening Speeches is the first phase that needs a clean
        // Proceed/readiness slate -- see allHumanDelegatesReady below.
        readyCountries: {},
        readyCheckOpen: false,
        updatedAt: serverTimestamp(),
      });
      return {
        phaseName,
        advancedTo: COMMITTEE_PHASES[OPENING_SPEECHES_PHASE_INDEX],
        rollCallSummary: null,
      };
    }

    // Motion Voting passing: the motion carries, so Caucus / Debate
    // begins -- the speaking order starts over at the first human
    // delegate (AI Delegates are skipped automatically, same as before).
    if (outcome === "passed" && data.phaseIndex === MOTION_VOTING_PHASE_INDEX && canActOnOutcome) {
      transaction.update(committeeStateRef, {
        phaseIndex: CAUCUS_DEBATE_PHASE_INDEX,
        votes: initialVotesForPhase(data.delegateRoles, CAUCUS_DEBATE_PHASE_INDEX),
        currentSpeakerIndex: findNextHumanSpeakerIndex(data.delegateRoles, 0),
        readyCountries: {},
        readyCheckOpen: false,
        updatedAt: serverTimestamp(),
      });
      return { phaseName, advancedTo: COMMITTEE_PHASES[CAUCUS_DEBATE_PHASE_INDEX], rollCallSummary: null };
    }

    // Motion Voting failing: that motion is dead -- back to Motion
    // Raising so a delegate can propose a different one.
    if (outcome === "failed" && data.phaseIndex === MOTION_VOTING_PHASE_INDEX && canActOnOutcome) {
      transaction.update(committeeStateRef, {
        phaseIndex: MOTION_RAISING_PHASE_INDEX,
        votes: initialVotesForPhase(data.delegateRoles, MOTION_RAISING_PHASE_INDEX),
        raisedMotion: null,
        readyCountries: {},
        readyCheckOpen: false,
        updatedAt: serverTimestamp(),
      });
      return {
        phaseName,
        advancedTo: COMMITTEE_PHASES[MOTION_RAISING_PHASE_INDEX],
        rollCallSummary: null,
        motionFailed: true,
      };
    }

    // The final Sign/Not Sign/Abstain vote passing: the resolution is
    // adopted and the session reaches its last phase, Conference
    // Results -- there's nothing left to vote on after this.
    if (outcome === "passed" && isFinalSigningVote(data.phaseIndex, data.subStage) && canActOnOutcome) {
      transaction.update(committeeStateRef, {
        phaseIndex: CONFERENCE_RESULTS_PHASE_INDEX,
        readyCountries: {},
        readyCheckOpen: false,
        updatedAt: serverTimestamp(),
      });
      return {
        phaseName,
        advancedTo: COMMITTEE_PHASES[CONFERENCE_RESULTS_PHASE_INDEX],
        rollCallSummary: null,
        sessionComplete: true,
      };
    }

    // Still undecided, or already failed with nowhere automatic to go
    // (Motion Voting is the only vote that reproposes on its own; the
    // final vote failing just leaves the Reset Vote button available)
    // -- just record the vote itself.
    transaction.update(committeeStateRef, {
      votes,
      updatedAt: serverTimestamp(),
    });
    return { phaseName, advancedTo: null, rollCallSummary: null };
  });

  if (!result) {
    return;
  }

  logActivity(
    "vote_cast",
    country,
    `${country} voted ${VOTE_CHOICE_LABELS[choice] ?? choice} during ${result.phaseName}.`,
  );

  if (result.advancedTo && !result.motionFailed) {
    logActivity(
      "phase_advanced",
      null,
      `Committee advanced from ${result.phaseName} to ${result.advancedTo} by majority vote.`,
    );
  }

  if (result.motionFailed) {
    logActivity(
      "motion_failed",
      null,
      "The raised motion did not reach a majority, so the committee returned to Motion Raising.",
    );
  }

  if (result.sessionComplete) {
    logActivity("session_complete", null, "The resolution passed its final vote by majority. Committee session complete.");
  }

  if (result.rollCallSummary) {
    logActivity(
      "roll_call_completed",
      null,
      `Roll call finished and the Roll Call Results chart was generated. ${result.rollCallSummary} ` +
        "Waiting for the Chair to start the conference.",
    );
  }
}

// Lets any delegate propose a motion during Motion Raising -- whichever
// one is raised can be swapped for a different motion any time before
// the chair opens the vote on it (see openMotionVote in chair.js).
export async function castMotion(country, motionType) {
  await ensureAnonymousUser();

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return;
    }
    const data = snapshot.data();
    if (data.phaseIndex !== MOTION_RAISING_PHASE_INDEX) {
      return;
    }

    transaction.update(committeeStateRef, {
      raisedMotion: { type: motionType, raisedBy: country },
      updatedAt: serverTimestamp(),
    });
  });

  logActivity("motion_raised", country, `${country} raised ${MOTION_TYPES[motionType] ?? motionType}.`);
}

// Lets whichever delegate currently has the floor during Caucus / Debate
// ask the Chair for permission to yield their remaining speaking time.
// This only SENDS the request (see pendingYieldRequest) -- the Chair
// has to approve it (approveYieldRequest in chair.js) before the floor
// actually moves to the next delegate. Purely a live, visible record;
// it doesn't cast a vote or advance the phase by itself.
export async function requestYield(country, message) {
  await ensureAnonymousUser();

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return;
    }

    const data = snapshot.data();
    // Guards against a stale form (left over from a previous render,
    // e.g. right before the session was reset or the floor already
    // moved on) ever sending a yield request for the wrong phase or
    // the wrong country.
    if (data.phaseIndex !== CAUCUS_DEBATE_PHASE_INDEX) {
      return;
    }
    const currentSpeakerIndex = data.currentSpeakerIndex ?? 0;
    if (COMMITTEE_COUNTRIES[currentSpeakerIndex] !== country) {
      return;
    }

    transaction.update(committeeStateRef, {
      pendingYieldRequest: { country, message },
      updatedAt: serverTimestamp(),
    });
  });

  logActivity(
    "yield_requested",
    country,
    `${country} asked to yield their remaining speaking time to the Chair: “${message}”`,
  );
}

// Chair-only: the "Start Conference" button's action (see chair.js).
// Closes delegate registration for good -- after this, claimDelegateSeat
// always throws "locked" (see above), no matter how someone reaches the
// join form. Any country nobody claimed becomes an AI Delegate; any
// country a real visitor claimed through a join code stays Human. If
// literally nobody joined before this was clicked, every country
// (including the one the Chair would have run) becomes AI, and
// chairIsAi flips on so chair.js knows to drive the whole conference
// itself once a topic is chosen (see chooseTopic and the auto-advance
// loop, both in chair.js). Returns null if there's no session to lock,
// or if it was already locked (so a double-click can't re-roll
// delegateRoles out from under delegates who already joined).
async function lockRosterAndStart({ initiatedByDelegate = false } = {}) {
  const result = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return null;
    }

    const data = snapshot.data();
    if (data.rosterLocked) {
      return null;
    }

    const assignments = data.delegateAssignments ?? {};
    const claimedCountries = new Set(Object.values(assignments));
    const anyoneJoined = claimedCountries.size > 0;

    // Everyone who actually claimed a seat stays Human; every other
    // country (and, if nobody joined at all, every country) becomes
    // an AI Delegate.
    const newDelegateRoles = {};
    COMMITTEE_COUNTRIES.forEach((country) => {
      newDelegateRoles[country] = claimedCountries.has(country) ? "human" : "ai";
    });

    // Starting from the Chair dashboard (chair.html): the Chair is a
    // real person right here, so the committee only needs the AI to
    // run the whole thing if nobody else showed up either. Starting
    // from the delegate page (delegate.html) is different -- by
    // definition nobody there is playing Chair, so the AI always has
    // to drive the dashboard side, no matter how many delegates
    // joined. The delegate page also has no topic-picker UI of its
    // own (that's a Chair-only control -- see chooseTopic in
    // chair.js), so this immediately confirms whichever topic the
    // conference already had (see randomTopicId, used when the
    // conference was first created) instead of waiting on a pick that
    // has nowhere to happen.
    const chairIsAi = initiatedByDelegate || !anyoneJoined;

    transaction.update(committeeStateRef, {
      rosterLocked: true,
      chairIsAi,
      ...(initiatedByDelegate ? { topicConfirmedByChair: true } : {}),
      delegateRoles: newDelegateRoles,
      votes: initialVotesForPhase(newDelegateRoles, data.phaseIndex, data.subStage),
      updatedAt: serverTimestamp(),
    });

    return { anyoneJoined, chairIsAi, newDelegateRoles };
  });

  if (!result) {
    return null;
  }

  logActivity(
    "roster_locked",
    null,
    initiatedByDelegate
      ? "A delegate started the conference without a Chair present -- the AI is now running the Chair's side of things too."
      : result.anyoneJoined
        ? "The Chair started the conference. Registration is now closed and every unclaimed seat became an AI Delegate."
        : "The Chair started the conference with nobody having joined -- every seat, including the Chair, became AI.",
  );

  return result;
}

// Moves the committee on from Opening Speeches to Motion Raising --
// nothing here is delegate-voted, so only the Chair (a human clicking
// "Begin Motion Raising" in chair.js, or the AI-auto-advance driver
// below once chairIsAi is true) ever calls this. Returns false (and
// changes nothing) if the committee has already moved on -- chair.js
// uses that to show the right status text; the driver just moves on
// to its next tick.
export async function advanceOpeningSpeechesPhase() {
  const applied = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return false;
    }
    const data = snapshot.data();
    if (data.phaseIndex !== OPENING_SPEECHES_PHASE_INDEX) {
      return false;
    }
    transaction.update(committeeStateRef, {
      phaseIndex: MOTION_RAISING_PHASE_INDEX,
      raisedMotion: null,
      readyCountries: {},
      readyCheckOpen: false,
      updatedAt: serverTimestamp(),
    });
    return true;
  });

  if (applied) {
    logActivity("phase_advanced", null, "Committee advanced from Opening Speeches to Motion Raising -- the Chair moved things along.");
  }
  return applied;
}

// Opens the country-by-country vote on whichever motion is currently
// raised -- only usable once a delegate (human or AI, see castMotion
// above) has actually raised one. Same caller shape as
// advanceOpeningSpeechesPhase above.
export async function openRaisedMotionVote() {
  const applied = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return false;
    }
    const data = snapshot.data();
    if (data.phaseIndex !== MOTION_RAISING_PHASE_INDEX || !data.raisedMotion) {
      return false;
    }
    transaction.update(committeeStateRef, {
      phaseIndex: MOTION_VOTING_PHASE_INDEX,
      votes: initialVotesForPhase(data.delegateRoles, MOTION_VOTING_PHASE_INDEX),
      readyCountries: {},
      readyCheckOpen: false,
      updatedAt: serverTimestamp(),
    });
    return true;
  });

  if (applied) {
    logActivity("motion_vote_opened", null, "The Chair opened the vote on the raised motion.");
  }
  return applied;
}

// Moves the committee on from Caucus / Debate to the drafting round of
// Resolution / Final Vote -- again, Chair-only (human or AI). Same
// caller shape as the two functions above.
export async function beginResolutionDrafting() {
  const applied = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return false;
    }
    const data = snapshot.data();
    if (data.phaseIndex !== CAUCUS_DEBATE_PHASE_INDEX) {
      return false;
    }
    transaction.update(committeeStateRef, {
      phaseIndex: RESOLUTION_VOTE_PHASE_INDEX,
      subStage: "drafting",
      pendingYieldRequest: null,
      readyCountries: {},
      readyCheckOpen: false,
      updatedAt: serverTimestamp(),
    });
    return true;
  });

  if (applied) {
    logActivity("phase_advanced", null, "Committee advanced from Caucus / Debate to Resolution / Final Vote -- the Chair moved things along.");
  }
  return applied;
}

// Opens the final Sign/Not Sign/Abstain vote -- only usable during the
// "drafting" half of Resolution / Final Vote. Locks the draft
// resolution for editing the moment this runs (see
// isResolutionEditablePhase above). Same caller shape as the three
// functions above.
export async function openFinalResolutionVote() {
  const applied = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return false;
    }
    const data = snapshot.data();
    if (data.phaseIndex !== RESOLUTION_VOTE_PHASE_INDEX || data.subStage !== "drafting") {
      return false;
    }
    transaction.update(committeeStateRef, {
      subStage: "voting",
      votes: initialVotesForPhase(data.delegateRoles, RESOLUTION_VOTE_PHASE_INDEX, "voting"),
      readyCountries: {},
      readyCheckOpen: false,
      updatedAt: serverTimestamp(),
    });
    return true;
  });

  if (applied) {
    logActivity("final_vote_opened", null, "The Chair opened the final Sign/Not Sign/Abstain vote.");
  }
  return applied;
}

// A human delegate's "Proceed" / "I'm Ready" click (see the button in
// committee.js). Just records it for the CURRENT phase -- in an
// AI-run conference (chairIsAi), the AI-auto-advance driver below
// checks this on its next tick and moves on once every human-run
// country has clicked it (see allHumanDelegatesReady below); in a
// human-chaired conference, the Chair just watches these come in on
// their own dashboard (after opening a readiness check -- see
// openReadinessCheck right below) and decides for themselves when to
// click whichever existing phase-advance button applies. Does nothing
// if this country isn't actually a human-run seat (an AI Delegate has
// nothing to click, and a stale button left over from a role change
// should never write anything).
export async function markReadyToProceed(country) {
  await ensureAnonymousUser();

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return;
    }
    const data = snapshot.data();
    if (data.delegateRoles?.[country] !== "human") {
      return;
    }
    transaction.update(committeeStateRef, {
      [`readyCountries.${country}`]: true,
      updatedAt: serverTimestamp(),
    });
  });

  logActivity("marked_ready", country, `${country} clicked Proceed / I'm Ready for the current phase.`);
}

// Chair-only: opens a fresh "poll for final check" for the current
// phase in a human-chaired conference -- clears readyCountries and
// sets readyCheckOpen so delegates see the prompt to click "I'm Ready"
// (see renderCommitteeState in committee.js). Purely informational:
// clicking whichever existing phase-advance button applies still
// works exactly the same regardless of what this collects, and this
// is never used in an AI-run conference, where delegates can already
// click Proceed at any time.
export async function openReadinessCheck() {
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return;
    }
    transaction.update(committeeStateRef, {
      readyCheckOpen: true,
      readyCountries: {},
      updatedAt: serverTimestamp(),
    });
  });

  logActivity("readiness_check_opened", null, "The Chair opened a readiness check for the current phase.");
}

// ---- AI-auto-advance driver --------------------------------------------
// Runs only once chairIsAi and topicConfirmedByChair are both true (see
// lockRosterAndStart above) -- nobody is left to click anything here,
// human delegate or Chair, once a topic is confirmed. Every few
// seconds, this looks at the current committee state and performs
// exactly one step forward by calling the exact same function a real
// click or vote would call -- castVote / castMotion above for whatever
// a delegate would do, startConferenceAndAnnounce and the four
// functions just above for whatever the Chair would do. Shared here
// (rather than living in chair.js or committee.js separately) so it
// runs the same way no matter which page happens to be open: the Chair
// dashboard (chair.html) if the conference's owner is watching it, or
// the delegate page (delegate.html) if a lone delegate started the
// conference themselves with nobody playing Chair at all (see
// lockRosterAndStart's initiatedByDelegate option). Keeps running for
// as long as that one browser tab stays open -- there's no server-side
// automation in this app, so closing the tab simply stops it.
let aiAdvanceIntervalId = null;
let aiAdvanceTickInFlight = false;

// True once every human-run country has clicked "Proceed" for the
// CURRENT phase (see markReadyToProceed above) -- true vacuously if
// nobody is actually human-run (the fully-empty-roster case). This is
// what stops the driver below from racing past a real human delegate:
// without it, the driver would treat Opening Speeches, Motion Raising,
// Caucus / Debate, and Resolution Drafting exactly like the fully-AI
// case and move on before that delegate had any chance to listen to or
// generate a speech, raise their own motion, actually debate, or write
// anything into the resolution.
function allHumanDelegatesReady(data) {
  const ready = data.readyCountries ?? {};
  return COMMITTEE_COUNTRIES.filter((country) => data.delegateRoles[country] === "human").every(
    (country) => ready[country] === true,
  );
}

// One step forward, picked purely from whatever phase/subStage/
// setupStage the committee is currently in. Does nothing if another
// tick is still in flight, so two ticks can never race each other.
async function runAiAutoAdvanceTick() {
  if (aiAdvanceTickInFlight || !latestCommitteeState) {
    return;
  }

  const data = latestCommitteeState;
  if (!data.chairIsAi || !data.topicConfirmedByChair || data.phaseIndex === CONFERENCE_RESULTS_PHASE_INDEX) {
    return;
  }

  aiAdvanceTickInFlight = true;
  try {
    const firstCountry = COMMITTEE_COUNTRIES[0];

    if (data.phaseIndex === SETUP_PHASE_INDEX) {
      // Conference Setup stays fully automatic no matter who's
      // actually human-run -- an AI majority alone already covers the
      // presence check and the goal-agreement poll, and there's
      // nothing for a human delegate to actually DO in either one
      // beyond a vote the AI majority doesn't need their help with.
      if (data.setupStage === SETUP_STAGE.ROLL_CALL) {
        // Every AI Delegate's presence vote is already "yes" (see
        // initialVotesForPhase) -- re-casting the first one triggers
        // the same majority check a real click would.
        await castVote(firstCountry, "yes");
      } else if (data.setupStage === SETUP_STAGE.AWAITING_START) {
        await startConferenceAndAnnounce();
      } else if (data.setupStage === SETUP_STAGE.GOAL_POLL) {
        await castVote(firstCountry, "yes");
      }
      return;
    }

    // Every phase from here on holds this tick until every human-run
    // country has clicked Proceed (see allHumanDelegatesReady above)
    // -- this is what gives a real human delegate actual time to
    // listen to or generate a speech, raise their own motion, debate,
    // or write into the resolution, instead of the driver just
    // ticking straight through every few seconds regardless.
    if (data.phaseIndex === OPENING_SPEECHES_PHASE_INDEX) {
      if (allHumanDelegatesReady(data)) {
        await advanceOpeningSpeechesPhase();
      }
      return;
    }

    if (data.phaseIndex === MOTION_RAISING_PHASE_INDEX) {
      if (!data.raisedMotion) {
        // Proposing SOME motion to discuss isn't a real decision
        // worth gating -- any human delegate who wants their own
        // motion instead can still raise one themselves before the
        // vote opens, which replaces this one (see castMotion above).
        await castMotion(firstCountry, "moderated_caucus");
      } else if (allHumanDelegatesReady(data)) {
        await openRaisedMotionVote();
      }
      return;
    }

    if (data.phaseIndex === MOTION_VOTING_PHASE_INDEX) {
      // Not gated here -- castVote above already refuses to act on an
      // AI-majority "passed" outcome until every human-run country has
      // cast their own real vote, so this nudge can never race past
      // one. Casting a real Yes/No vote IS that delegate's Proceed
      // signal for this phase.
      await castVote(firstCountry, "yes");
      return;
    }

    if (data.phaseIndex === CAUCUS_DEBATE_PHASE_INDEX) {
      if (allHumanDelegatesReady(data)) {
        await beginResolutionDrafting();
      }
      return;
    }

    if (data.phaseIndex === RESOLUTION_VOTE_PHASE_INDEX) {
      if (data.subStage === "drafting") {
        if (allHumanDelegatesReady(data)) {
          await openFinalResolutionVote();
        }
      } else {
        // Same as Motion Voting above: castVote's own gate already
        // waits for every human-run country's real vote, and casting
        // it IS that delegate's Proceed signal for this phase.
        await castVote(firstCountry, "sign");
      }
      return;
    }
  } catch (error) {
    console.error("AI auto-advance step failed:", error);
  } finally {
    aiAdvanceTickInFlight = false;
  }
}

// Starts or stops the auto-advance timer to match whether it should
// currently be running -- chair.js and committee.js each call this
// from their own render function every time the committee state
// updates, so it always tracks the live state instead of needing a
// separate listener of its own.
export function syncAiAutoAdvance(data) {
  const shouldRun = data.chairIsAi === true && data.topicConfirmedByChair === true && data.phaseIndex !== CONFERENCE_RESULTS_PHASE_INDEX;

  if (shouldRun && aiAdvanceIntervalId == null) {
    aiAdvanceIntervalId = window.setInterval(() => {
      runAiAutoAdvanceTick().catch((error) => console.error("AI auto-advance tick failed:", error));
    }, 4000);
  } else if (!shouldRun && aiAdvanceIntervalId != null) {
    window.clearInterval(aiAdvanceIntervalId);
    aiAdvanceIntervalId = null;
  }
}

// Lets committee.js and chair.js update the shared latestCommitteeState
// value above -- an imported binding can be read directly by any module
// that imports it (ES modules keep it live), but only this module can
// assign to it, so every importer updates it through this setter.
export function setLatestCommitteeState(data) {
  latestCommitteeState = data;
}

export {
  COMMITTEE_PHASE_DESCRIPTIONS,
  COMMITTEE_TOPICS,
  COMMITTEE_COUNTRIES,
  formatDelegateLabel,
  getTopic,
  randomTopicId,
  COMMITTEE_PHASES,
  SETUP_PHASE_INDEX,
  OPENING_SPEECHES_PHASE_INDEX,
  MOTION_RAISING_PHASE_INDEX,
  MOTION_VOTING_PHASE_INDEX,
  CAUCUS_DEBATE_PHASE_INDEX,
  RESOLUTION_VOTE_PHASE_INDEX,
  CONFERENCE_RESULTS_PHASE_INDEX,
  MOTION_TYPES,
  SETUP_STAGE,
  conferenceWelcomeMessage,
  startConferenceAndAnnounce,
  findNextHumanSpeakerIndex,
  VOTE_THRESHOLD,
  VOTE_CHOICE_LABELS,
  VOTE_CHOICE_BUTTON_CLASSES,
  isFinalSigningVote,
  voteOutcome,
  RESOLUTION_MAX_LENGTH,
  RESOLUTION_EDITABLE_START_INDEX,
  isResolutionEditablePhase,
  randomDelegateRoles,
  initialVotesForPhase,
  logActivity,
  ensureCommitteeState,
  setActiveSessionCode,
  getCommitteeMessagesCollection,
  createOwnedConference,
  joinSessionByCode,
  claimDelegateSeat,
  lockRosterAndStart,
};
