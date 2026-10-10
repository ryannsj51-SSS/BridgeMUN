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
  "Chair proposes a topic; delegates vote to adopt it.",
  "Chair checks who's present; delegates confirm attendance.",
  "Delegates give prepared opening speeches, in order.",
  "Delegates yield remaining speech time to the chair.",
  "Short, chair-recognized speeches on one part of the topic.",
  "Delegates negotiate freely and start drafting solutions.",
  "Delegates write working papers and draft resolutions.",
  "Delegates sign on as sponsors or signatories.",
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

// Looks up one topic's full record (name, description, delegate speeches)
// by its id. Returns null if the id doesn't match any known topic.
function getTopic(topicId) {
  return COMMITTEE_TOPICS.find((topic) => topic.id === topicId) ?? null;
}

// Picks a random topic id, optionally leaving one out -- used when the
// chair needs to propose a *different* topic after a failed or timed-out
// Setting the Agenda vote.
function randomTopicId(excludeId) {
  const pool = COMMITTEE_TOPICS.filter((topic) => topic.id !== excludeId);
  const choices = pool.length > 0 ? pool : COMMITTEE_TOPICS;
  return choices[Math.floor(Math.random() * choices.length)].id;
}

// The real Model UN procedure this committee follows, in order. The
// committee starts by Setting the Agenda (choosing its topic) and needs a
// majority vote (more than half of all delegates) to move on to each next
// phase -- there is no abstaining except during Signing, the last phase.
const COMMITTEE_PHASES = [
  "Setting the Agenda",
  "Presence Check",
  "General Speakers List",
  "Yield Time",
  "Moderated Caucus",
  "Unmoderated Caucus",
  "Drafting Solutions",
  "Signing",
];

// Fixed positions of the phases the code needs to treat specially:
// Setting the Agenda (the topic vote, with anonymity and a time limit),
// Presence Check (where an AI Delegate's automatic Yes reads as
// "Present"), and Yield Time (where delegates take turns yielding their
// remaining speaking time to the Chair, one at a time, in order).
const TOPIC_PHASE_INDEX = 0;
const PRESENCE_CHECK_PHASE_INDEX = 1;
const YIELD_TIME_PHASE_INDEX = COMMITTEE_PHASES.indexOf("Yield Time");

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

// How long delegates have to vote on a proposed topic before the chair
// gives up on it and proposes a different one automatically.
const TOPIC_VOTE_DURATION_MS = 60000;

// More than half of all delegates must land on the passing choice to
// succeed (e.g. 4 of 7). Every phase votes Yes/No except Signing, the
// last phase, which votes Sign/Not Sign/Abstain instead -- abstaining is
// allowed there (unlike every earlier phase) but still doesn't count
// toward the majority needed to actually sign the resolution.
const VOTE_THRESHOLD = Math.floor(COMMITTEE_COUNTRIES.length / 2) + 1;

const VOTE_CHOICE_LABELS = {
  yes: "Yes",
  no: "No",
  sign: "Sign",
  not_sign: "Not Sign",
  abstain: "Abstain",
  agree: "Agree",
  disagree: "Disagree",
};

const VOTE_CHOICE_BUTTON_CLASSES = {
  yes: "vote-yes",
  no: "vote-no",
  sign: "vote-yes",
  not_sign: "vote-no",
  abstain: "vote-abstain",
  agree: "vote-yes",
  disagree: "vote-no",
};

function isSigningPhase(phaseIndex) {
  return phaseIndex === COMMITTEE_PHASES.length - 1;
}

function isTopicPhase(phaseIndex) {
  return phaseIndex === TOPIC_PHASE_INDEX;
}

// Decides whether the votes cast so far already add up to a majority for
// passingValue ("yes" for every phase except Signing, where it's "sign"),
// have already made that majority impossible no matter how any remaining
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

// Every meeting the chair starts gets its own random 6-digit code (like
// a Kahoot game PIN) instead of the whole site sharing one permanent
// committee. Firestore layout:
//   appState/activeSession                -- { code } for whichever
//                                             session is currently live
//                                             (there's only ever one,
//                                             since there's only one
//                                             chair account)
//   sessions/{code}/committee/state       -- same shape committee/state
//                                             used to be
//   sessions/{code}/committee/resolution  -- same shape committee/
//                                             resolution used to be
//   sessions/{code}/committeeMessages/*   -- same shape as before
//   sessions/{code}/activityLog/*         -- same shape as before
const activeSessionPointerRef = doc(db, "appState", "activeSession");

// Which session this browser tab is looking at, and the two document
// references everything below reads and writes -- all three start out
// unknown. chair.js and committee.js must resolve a code (see
// resolveActiveSessionCode/joinSessionByCode/startNewSession below)
// before any of the rest of this module's Firestore calls will work.
let activeSessionCode = null;
export let committeeStateRef = null;
export let committeeResolutionRef = null;
export let latestCommitteeState = null;

const RESOLUTION_MAX_LENGTH = 20000;

// Delegates can edit the shared draft resolution during Moderated
// Caucus, Unmoderated Caucus, and Drafting Solutions -- found by phase
// name (rather than hard-coded numbers) so this stays correct even if
// phases are ever reordered. Locked everywhere else, including Signing,
// so delegates can review exactly what they're voting to sign without
// being able to change it mid-vote.
const RESOLUTION_EDITABLE_START_INDEX = COMMITTEE_PHASES.indexOf("Moderated Caucus");
const RESOLUTION_EDITABLE_END_INDEX = COMMITTEE_PHASES.indexOf("Drafting Solutions");

function isResolutionEditablePhase(phaseIndex) {
  return phaseIndex >= RESOLUTION_EDITABLE_START_INDEX && phaseIndex <= RESOLUTION_EDITABLE_END_INDEX;
}

// Randomly splits the seven delegates into two AI Delegates and five
// Human Delegates. Called once per committee session (see
// startNewSession). Kept at exactly two AI Delegates regardless of
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

// Starts a fresh vote for the given phase: AI Delegates auto-vote
// immediately (they have no real person to click a button for them, and
// keeping this a fixed automatic choice rather than an actual AI decision
// keeps the site free to run) -- Agree on Setting the Agenda, Sign on the
// Signing phase, Yes everywhere else. Human Delegates always start blank.
function initialVotesForPhase(delegateRoles, phaseIndex) {
  const aiChoice = isSigningPhase(phaseIndex) ? "sign" : isTopicPhase(phaseIndex) ? "agree" : "yes";
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

// Creates the shared committee state the first time anyone loads the page
// (picking a random AI/Human split), but does nothing if it already
// exists -- every later visitor just reads the same state below.
async function ensureCommitteeState() {
  await ensureAnonymousUser();
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);

    if (snapshot.exists()) {
      const data = snapshot.data();
      // Repairs a committee session that was created before Setting the
      // Agenda existed: if it's sitting on that phase without the topic
      // and deadline fields it now needs, fill them in here instead of
      // leaving the topic banner blank and the countdown showing NaN.
      const missingTopicFields = typeof data.topicId !== "string" || typeof data.topicVoteDeadlineMs !== "number";
      // Repairs a committee session that was created before delegates
      // were assigned their own country -- without this, an older
      // session's document simply has no delegateAssignments field at
      // all, which would make every country look "unclaimed" forever.
      const missingAssignments = data.delegateAssignments == null || typeof data.delegateAssignments !== "object";
      // Repairs a committee session that was created before Yield Time
      // tracked a speaking order -- without this, an older session's
      // document has no currentSpeakerIndex at all.
      const missingSpeakerIndex = typeof data.currentSpeakerIndex !== "number";
      if ((data.phaseIndex === TOPIC_PHASE_INDEX && missingTopicFields) || missingAssignments || missingSpeakerIndex) {
        transaction.update(committeeStateRef, {
          ...(data.phaseIndex === TOPIC_PHASE_INDEX && missingTopicFields
            ? {
                votes: initialVotesForPhase(data.delegateRoles, TOPIC_PHASE_INDEX),
                topicId: randomTopicId(null),
                topicVoteAnonymous: {},
                topicVoteDeadlineMs: Date.now() + TOPIC_VOTE_DURATION_MS,
              }
            : {}),
          ...(missingAssignments ? { delegateAssignments: {} } : {}),
          ...(missingSpeakerIndex
            ? {
                currentSpeakerIndex:
                  data.phaseIndex === YIELD_TIME_PHASE_INDEX ? findNextHumanSpeakerIndex(data.delegateRoles, 0) : 0,
              }
            : {}),
          updatedAt: serverTimestamp(),
        });
      }
      return;
    }

    const delegateRoles = randomDelegateRoles();
    transaction.set(committeeStateRef, {
      phaseIndex: TOPIC_PHASE_INDEX,
      delegateRoles,
      votes: initialVotesForPhase(delegateRoles, TOPIC_PHASE_INDEX),
      topicId: randomTopicId(null),
      topicVoteAnonymous: {},
      topicVoteDeadlineMs: Date.now() + TOPIC_VOTE_DURATION_MS,
      rollCallVotes: null,
      // A brand-new session has nobody assigned to a country yet -- each
      // delegate who joins claims one of the five human-run countries
      // for themselves (see claimDelegateCountry in committee.js).
      delegateAssignments: {},
      // Unused until the committee actually reaches Yield Time (see
      // castVote in committee.js, which sets this properly the moment
      // it gets there) -- 0 here is just a harmless placeholder.
      currentSpeakerIndex: 0,
      updatedAt: serverTimestamp(),
    });
  });
}

// Starts a brand-new committee session: a fresh random AI/Human split, a
// freshly proposed topic, back to Setting the Agenda, and every vote
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

// Chair-only: finds the chair's current meeting code, creating a brand
// new session (and a brand new code) the very first time there's never
// been one. A later chair sign-in resumes the SAME code and data instead
// of starting over -- only startNewSession (below) retires a code.
async function resolveActiveSessionCode() {
  const pointerSnapshot = await getDoc(activeSessionPointerRef);
  const existingCode = pointerSnapshot.data()?.code;
  if (typeof existingCode === "string") {
    return existingCode;
  }

  const code = await generateUniqueSessionCode();
  await setDoc(activeSessionPointerRef, { code, updatedAt: serverTimestamp() });
  return code;
}

// Delegate-only: checks a code a visitor typed in against the chair's
// actual current meeting code. On a match, switches every shared
// reference above over to that session and returns true; returns false
// if it's wrong, stale (the chair has since reset), or no meeting is
// running yet.
async function joinSessionByCode(code) {
  const pointerSnapshot = await getDoc(activeSessionPointerRef);
  const activeCode = pointerSnapshot.data()?.code;
  if (typeof activeCode !== "string" || activeCode !== code) {
    return false;
  }
  setActiveSessionCode(code);
  return true;
}

// Chair-only: retires the current meeting code and starts a brand-new
// session under a fresh one -- a new random AI/Human split, a freshly
// proposed topic, back to Setting the Agenda, every vote cleared. Used
// by the chair dashboard's Reset Committee Session button. Returns the
// new code so chair.js can display it right away.
async function startNewSession() {
  const code = await generateUniqueSessionCode();
  const delegateRoles = randomDelegateRoles();
  const topicId = randomTopicId(null);
  const newStateRef = doc(db, "sessions", code, "committee", "state");

  await runTransaction(db, async (transaction) => {
    transaction.set(newStateRef, {
      phaseIndex: TOPIC_PHASE_INDEX,
      delegateRoles,
      votes: initialVotesForPhase(delegateRoles, TOPIC_PHASE_INDEX),
      topicId,
      topicVoteAnonymous: {},
      topicVoteDeadlineMs: Date.now() + TOPIC_VOTE_DURATION_MS,
      rollCallVotes: null,
      // A brand-new session has nobody assigned to a country yet -- each
      // delegate who joins claims one of the five human-run countries
      // for themselves (see claimDelegateCountry in committee.js).
      delegateAssignments: {},
      // Unused until Yield Time -- see castVote in committee.js, which
      // sets this properly once the committee actually gets there.
      currentSpeakerIndex: 0,
      updatedAt: serverTimestamp(),
    });
  });

  await setDoc(activeSessionPointerRef, { code, updatedAt: serverTimestamp() });
  setActiveSessionCode(code);

  const aiCountries = COMMITTEE_COUNTRIES.filter((country) => delegateRoles[country] === "ai").join(", ");
  logActivity(
    "session_reset",
    null,
    `Committee session restarted from Setting the Agenda with a new proposed topic: ${getTopic(topicId)?.name}. AI Delegates this session: ${aiCountries}.`,
  );

  return code;
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
  getTopic,
  randomTopicId,
  COMMITTEE_PHASES,
  TOPIC_PHASE_INDEX,
  PRESENCE_CHECK_PHASE_INDEX,
  YIELD_TIME_PHASE_INDEX,
  findNextHumanSpeakerIndex,
  TOPIC_VOTE_DURATION_MS,
  VOTE_THRESHOLD,
  VOTE_CHOICE_LABELS,
  VOTE_CHOICE_BUTTON_CLASSES,
  isSigningPhase,
  isTopicPhase,
  voteOutcome,
  RESOLUTION_MAX_LENGTH,
  RESOLUTION_EDITABLE_START_INDEX,
  RESOLUTION_EDITABLE_END_INDEX,
  isResolutionEditablePhase,
  randomDelegateRoles,
  initialVotesForPhase,
  logActivity,
  ensureCommitteeState,
  setActiveSessionCode,
  getCommitteeMessagesCollection,
  resolveActiveSessionCode,
  joinSessionByCode,
  startNewSession,
};
