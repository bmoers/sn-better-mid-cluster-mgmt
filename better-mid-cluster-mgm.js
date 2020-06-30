/**
 * Better MID Cluster Management
 * 
 * This is a drop in replacement for the 'MID Server Cluster Management' business rule (/sys_script.do?sys_id=297749870a0006bc2145d31c2d2335b9)
 * Make sure /sys_script.do?sys_id=297749870a0006bc2145d31c2d2335b9 is active=false!
 * 
 * Unfortunately the OOB LB/FO script is not very mature and assigns always the same FO agent in case of agent down.
 * 
 * For more details see https://github.com/bmoers/sn-better-mid-cluster-mgmt/blob/master/README.md
 * 
 * The source and test cases can be found here https://github.com/bmoers/sn-better-mid-cluster-mgmt
 * 
*/
(function (current) {

    /**
     * Find a Load Balancer for the passed Agent.
     * Lookup logic:
     *  - get all load balancer agents of the current agent
     *  - find failover agents for stopped load balancer agents
     *  - get a random agent from all agents collected above
     * 
     * (This function runs only 2 SQL queries in total)
     * 
     * @param {GlideRecord} agentGr The GlideRecord of the agent to load balance or failover
     * @returns {String} The agent name (The LB or if no LB found the current one)
     */
    var findLoadBalancerForAgent = function (agentGr) {

        if (!agentGr)
            return;

        var agentSysId = agentGr.getValue('sys_id');
        var agentFallbackName = "mid.server." + agentGr.getValue('name');

        var UP_STATE = 'Up';
        var FAILOVER = 'Failover';

        var DEBUG_ENABLED = gs.getProperty('better_mid_server.cluster.debug', 'false') == 'true';

        var log = {
            debug: function () {
                if (!DEBUG_ENABLED)
                    return;
                var args = Array.prototype.slice.call(arguments);
                if (args.length)
                    args[0] = '[Better MID Cluster] : ' + args[0];
                gs.debug.apply(this, args);
            },
            info: function () {
                var args = Array.prototype.slice.call(arguments);
                if (args.length)
                    args[0] = '[Better MID Cluster] : ' + args[0];
                gs.info.apply(this, args);
            }
        };


        /**
         * Helper function to make fields in an array unique.
         * @param {*} value 
         * @param {*} index 
         * @param {*} self 
         */
        var onlyUnique = function (value, index, self) {
            return self.indexOf(value) === index;
        };

        /**
         * Find all capabilities for the passed agents in ONE sql query.
         * 
         * @param {Array} agentSysIds 
         * @returns {Object} object with capabilities per key
         */
        var _getAgentCapabilities = function (agentSysIds) {

            if (!agentSysIds)
                return null;

            var agentCaps = {};
            var agentSysIdArr = Array.isArray(agentSysIds) ? agentSysIds : [agentSysIds];

            var gr = new GlideRecord("ecc_agent_capability_m2m");
            gr.addQuery("agent", 'IN', agentSysIdArr.join(','));
            gr.query();

            log.debug("_getAgentCapabilities : ecc_agent_capability_m2m.do " + gr.getEncodedQuery());

            while (gr.next()) {

                var sysId = gr.getValue('agent');
                if (!agentCaps[sysId])
                    agentCaps[sysId] = [];

                if (JSUtil.nil(gr.capability.value)) {
                    agentCaps[sysId].push(gr.capability.capability.toString());
                } else {
                    agentCaps[sysId].push(gr.capability.capability.toString() + ':' + gr.capability.value.toString());

                }
            }

            return agentCaps;
        };

        /**
         * Check if Array2 is in Array1
         * @param {*} array1 
         * @param {*} array2 
         * @returns {Boolean}
         */
        var _isSubset = function (array1, array2) {
            var resArray = new ArrayUtil().intersect(array1, array2);
            if (resArray.length == array1.length)
                return true;

            return false;
        };

        /**
         * Find all cluster agents which have the same or more capabilities
         * In contrast to the OOB ServiceNow function, this also treats 'ALL' as 
         * capable to take over all other capabilities.
         * 
         * @param {String} agentSysId 
         * @param {Array} failoverAgents 
         * @returns {Array} list holding the sys_id of the capable agents
         */
        var _filterOnCapabilities = function (agentSysId, failoverAgents) {

            var agentCaps = _getAgentCapabilities(agentSysId)[agentSysId];

            var newClusterAgents = [];
            if (!agentCaps)
                return newClusterAgents;

            var foCapabilities = _getAgentCapabilities(failoverAgents);
            if (!foCapabilities)
                return newClusterAgents;


            Object.keys(foCapabilities).forEach(function (foAgentSysId) {
                var candidateCaps = foCapabilities[foAgentSysId];
                log.debug("_filterOnCapabilities : Agent caps " + JSON.stringify(agentCaps) + " - candidateCaps :" + JSON.stringify(candidateCaps));

                // if the candidate can do 'ALL' it is always capable to take over
                if (candidateCaps.indexOf('ALL') !== -1) {
                    newClusterAgents.push(foAgentSysId);
                } else if (_isSubset(agentCaps, candidateCaps)) { // check the candidate capabilities are more or equal the current
                    newClusterAgents.push(foAgentSysId);
                }
            });

            return newClusterAgents;
        };

        /**
         * Get the clusterMember construct.
         * @returns {Object} of following structure : {
                agents: {
                    SYS_ID: {
                        failover: [],
                        loadBalance: [],
                        up: true,
                        name : name
                    }
                },
                failover: {
                    SYS_ID : {
                        agentsUp: []
                    }
                },
                loadBalance: {
                    SYS_ID: {
                        agentsUp : []
                        agentsDown : []
                    }
                }
            };
         */
        var getAllClusterMembers = function () {

            // get all clusters
            var gr = new GlideRecord('ecc_agent_cluster_member_m2m');
            gr.query();
            var allClusters = {
                agents: {},
                failover: {},
                loadBalance: {}
            };

            // build up 'allClusters' object
            while (gr.next()) {

                var clusterSysId = gr.cluster.toString();
                var clusterType = gr.cluster.type.toString(); // 'Load Balance' / 'Failover'
                var type = (clusterType == FAILOVER) ? 'failover' : 'loadBalance';
                var isFailover = (clusterType == FAILOVER);

                var agentSysId = gr.agent.toString();
                var agentName = gr.agent.name.toString();
                var agentStatus = gr.agent.status.toString(); // 'Up' / 'Down' / 'Upgrade Failed'
                var isUp = (agentStatus == UP_STATE);

                // all agents
                if (!allClusters.agents[agentSysId])
                    allClusters.agents[agentSysId] = { failover: [], loadBalance: [], up: isUp, name: agentName };

                allClusters.agents[agentSysId][type].push(clusterSysId);

                // for the clusters we need all agents, regardless if up or down
                if (!allClusters[type][clusterSysId]) {
                    allClusters[type][clusterSysId] = { agentsUp: [] };
                    if (!isFailover) {
                        // only load balancer have agentsDown
                        allClusters[type][clusterSysId].agentsDown = [];
                    }
                }

                /*
                    add all LoadBalance clusters agents
                    add all running failover clusters agents
                */
                if (!isFailover) {
                    if (isUp) {
                        allClusters[type][clusterSysId].agentsUp.push(agentSysId);
                    } else {
                        allClusters[type][clusterSysId].agentsDown.push(agentSysId);
                    }
                } else if (isFailover && isUp) {
                    // only keep the running failover agents
                    allClusters[type][clusterSysId].agentsUp.push(agentSysId);
                }
                
            }

            log.debug('getAllClusterMembers : ' + JSON.stringify(allClusters));
            return allClusters;
        };

        var getRandomMidServer = function (sameCapFoAgents) {
            log.debug("getRandomMidServer : up and running agents with same capabilities " + JSON.stringify(sameCapFoAgents));

            var lbAgentsNum = sameCapFoAgents.length;
            if (lbAgentsNum) {
                var lbRandomPos = Math.floor(Math.random() * lbAgentsNum);
                var lbRandomSysId = sameCapFoAgents[lbRandomPos];

                var agentCache = new SNC.ECCAgentCache();
                var gr = agentCache.getBySysId(lbRandomSysId);

                if (gr) {
                    return "mid.server." + gr.getValue('name');
                }
            }
            return null;
        };

        var getSameCapAgentFromFailover = function (currAgent) {
            var upFailoverAgents = [];
            currAgent.failover.forEach(function (foSysId) {
                // find all the down load balancers nodes and replace it with one failover node
                var fo = allClusters.failover[foSysId];
                if (!fo)
                    return;

                upFailoverAgents = upFailoverAgents.concat(fo.agentsUp);
            });

            var sameCapFoAgents = _filterOnCapabilities(agentSysId, upFailoverAgents);
            return getRandomMidServer(sameCapFoAgents);
        };

        var getSameCapAgentFromLoadBalance = function (currAgent) {
            // list of agents to share the load
            var upLoadBalanceAgents = [];
            var downLoadBalanceAgents = [];
            var upFailoverAgents = [];

            // these are all load balancers to the current mid server
            currAgent.loadBalance.forEach(function (lbSysId) {
                // find all the down load balancers nodes and replace it with one failover node
                var loadBalancer = allClusters.loadBalance[lbSysId];
                if (!loadBalancer)
                    return;

                upLoadBalanceAgents = upLoadBalanceAgents.concat(loadBalancer.agentsUp);
                downLoadBalanceAgents = downLoadBalanceAgents.concat(loadBalancer.agentsDown);

            });

            // remove duplicates
            upLoadBalanceAgents = upLoadBalanceAgents.filter(onlyUnique);
            downLoadBalanceAgents = downLoadBalanceAgents.filter(onlyUnique);

            log.debug("getSameCapAgentFromLoadBalance : current agent load balancers " + JSON.stringify(currAgent.loadBalance));
            log.debug("getSameCapAgentFromLoadBalance : current agent running load balancer partners " + JSON.stringify(upLoadBalanceAgents));
            log.debug("getSameCapAgentFromLoadBalance : current agent stopped load balancer partners " + JSON.stringify(downLoadBalanceAgents));

            downLoadBalanceAgents.forEach(function (downAgentSysId) {
                var downAgent = allClusters.agents[downAgentSysId];
                // check if there is a failover in place for this agent
                if (!downAgent || downAgent.failover.length == 0)
                    return;

                downAgent.failover.forEach(function (failoverSysId) {
                    var failoverCluster = allClusters.failover[failoverSysId];
                    // check if the failover cluster has active agents
                    if (!failoverCluster || failoverCluster.agentsUp.length == 0)
                        return;

                    upFailoverAgents = upFailoverAgents.concat(failoverCluster.agentsUp);
                });
            });

            // remove duplicates
            upFailoverAgents = upFailoverAgents.filter(onlyUnique);

            log.debug("getSameCapAgentFromLoadBalance : up running failover agents " + JSON.stringify(upFailoverAgents) + " to take over from stopped " + JSON.stringify(downLoadBalanceAgents));
            log.debug("getSameCapAgentFromLoadBalance : num down agents " + downLoadBalanceAgents.length);
            log.debug("getSameCapAgentFromLoadBalance : num failover agents " + upFailoverAgents.length);

            // if there are less or equal number of failover agents in place, take them all
            if (upFailoverAgents.length <= downLoadBalanceAgents.length) {
                // we need all of them
                upLoadBalanceAgents = upLoadBalanceAgents.concat(upFailoverAgents);
            } else {
                // there are more failover agents available then we need to have, random pick some
                downLoadBalanceAgents.forEach(function () {
                    randomPos = Math.floor(Math.random() * upFailoverAgents.length);
                    // select a random failover from the remaining list
                    // splice makes the 'currentDownAgentsUpFailoverAgents' shorter by 1 every time it runs
                    upLoadBalanceAgents.push(upFailoverAgents.splice(randomPos, 1)[0]);
                });
            }

            log.debug("getSameCapAgentFromLoadBalance : up and running agents " + JSON.stringify(upLoadBalanceAgents));

            var sameCapFoAgents = _filterOnCapabilities(agentSysId, upLoadBalanceAgents);
            return getRandomMidServer(sameCapFoAgents);

        };

        // get all defined clusters and members on the platform
        var allClusters = getAllClusterMembers();

        // get the current agent object from that cluster
        var currAgent = allClusters.agents[agentSysId];

        // check if the agent hast at least one failover or loadBalance agent
        if (!currAgent || (currAgent.failover.length == 0 && currAgent.loadBalance.length == 0)) {
            // mid server has no failover or load balance configuration
            log.debug("no lb/fo agents found for agent (sys_id) " + agentSysId);
            return agentFallbackName;
        }

        // there are no LB but Failover agents
        if (currAgent.loadBalance.length == 0 && currAgent.failover.length != 0) {
            // get one random failover with same capability
            var foAgent = getSameCapAgentFromFailover(currAgent);
            return foAgent || agentFallbackName;
        }

        var lbAgent = getSameCapAgentFromLoadBalance(currAgent);
        return lbAgent || agentFallbackName;

    };

    /*
        this is OOB code from /sys_script.do?sys_id=297749870a0006bc2145d31c2d2335b9 (MID Server Cluster Management)
        START
    */
    var getMIDServerGr = function () {
        var agentName = current.agent;
        agentName = agentName.substring("mid.server.".length, agentName.length);

        var agentCache = new SNC.ECCAgentCache();
        var gr = agentCache.getByName(agentName);

        if (!gr)
            return;

        return gr;
    };

    if (current.topic == 'SystemCommand' || current.topic == "Command")
        return;

    if (current.topic == 'config.file')
        return;

    var agentGr = getMIDServerGr();
    if (JSUtil.nil(agentGr))
        return;

    // only use cluster for Shazzam if the MID is down
    if (current.topic == "Shazzam" && agentGr.status == "Up")
        return;

    // If probe param ECC_AGENT_SELECTOR_DETAILS exists in payload, then exit and don't use
    // legacy cluster management. For performance, uses a cached regex instead of a real XML parser.
    var midSelectorRegex = new SNC.Regex(GlideappIECC.ECC_AGENT_SELECTOR_DETAILS_REGEX + '');
    if (midSelectorRegex.match(current.payload))
        return;

    /*
        END
    */

    /*
        find a load balancer
    */
    current.agent = findLoadBalancerForAgent(agentGr);


})(current);