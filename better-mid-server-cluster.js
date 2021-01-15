/**
 * This is a drop in replacement for the OOB MIDServerCluster script include.
 * Make sure the OOB script include /sys_script_include.do?sys_id=f6c69a020a0006bc36db905d8d02dfc2 is active=false!
 *
 * Unfortunately the OOB LB/FO script is not very mature and assigns always the same FO agent in case of agent down.
 *
 * For more details see https://github.com/bmoers/sn-better-mid-cluster-mgmt/blob/master/README.md
 * The source and test cases can be found here https://github.com/bmoers/sn-better-mid-cluster-mgmt
 * 
 * @class 
 * @author Boris Moers [admin.moers]
 * @requires global.module:sys_script_include.SNC#ECCAgentCache
 * @memberof global.module:sys_script_include
 */
var MIDServerCluster = Class.create();
MIDServerCluster.prototype = /** @lends global.module:sys_script_include.MIDServerCluster.prototype */ {


    UP_STATE: 'Up',
    FAILOVER: 'Failover',

    log: {
        /**
         * Debug logger
         * 
         * @returns {undefined}
         */
        debug: function () {
            if (gs.getProperty('better_mid_server.cluster.debug', 'false') != 'true')
                return;
            var args = Array.prototype.slice.call(arguments);
            if (args.length)
                args[0] = '[Better MID Cluster] : ' + args[0];
            gs.debug.apply(this, args);
        },
        /**
         * Info logger
         * 
         * @returns {undefined}
         */
        info: function () {
            var args = Array.prototype.slice.call(arguments);
            if (args.length)
                args[0] = '[Better MID Cluster] : ' + args[0];
            gs.info.apply(this, args);
        }
    },

    /**
     * Constructor
     * 
     * @param {GlideRecord} agentGr ecc_agent which requires to be LB/FO
     * @param {String} requestedClusterType "Failover" or "Load Balance" - actually ignored
     * @returns {undefined}
     */
    initialize: function (agentGr, requestedClusterType) {
        var self = this;

        self.agentGr = agentGr;

        // get all defined clusters and members on the platform
        self.allClusters = self._getAllClusterMembers();

    },

    /**
     * Indicate if a LB/FO agent is available
     * 
     * @returns {boolean}
     */
    clusterExists: function () {
        var self = this;
        if (!self.agentGr)
            return false;

        var agentSysId = self.agentGr.getValue('sys_id');
        var currAgent = self.allClusters.agents[agentSysId];
        // ensure its a boolean
        return !!(currAgent && (currAgent.failover.length > 0 || currAgent.loadBalance.length > 0));

    },


    /**
     * Return the name of the agent to be LB/FO to.
     * This is only name of the ecc_agent ane must be prepended with "mid.server."
     * 
     * @returns {string} the agent name to LB/FO to
     */
    getClusterAgent: function () {
        var self = this;
        if (!self.agentGr)
            return;

        return self._findLoadBalancerForAgent(self.agentGr, self.allClusters);
    },

    /**
     * Return the names of all up and running agents.
     * 
     * @returns {Array} agent names
     */
    getClusterAgents: function () {
        var self = this;
        if (!self.agentGr)
            return [];

        return Object.keys(self.allClusters.agents).filter(function (sysId) {
            return self.allClusters.agents[sysId].up;
        }).map(function (sysId) {
            return self.allClusters.agents[sysId].name;
        });
    },



    /**
     * Get the clusterMember construct.
     * 
     * @protected
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
    _getAllClusterMembers: function () {
        var self = this;

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
            var type = (clusterType == self.FAILOVER) ? 'failover' : 'loadBalance';
            var isFailover = (clusterType == self.FAILOVER);

            var agentSysId = gr.agent.toString();
            var agentName = gr.agent.name.toString();
            var agentStatus = gr.agent.status.toString(); // 'Up' / 'Down' / 'Upgrade Failed'
            var isUp = (agentStatus == self.UP_STATE);

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

        self.log.debug('_getAllClusterMembers : ' + JSON.stringify(allClusters));
        return allClusters;
    },


    /**
     * Find a load balancer and if required failover agents
     * 
     * @protected
     * @param {GlideRecord} agentGr
     * @param {Object} allClusters
     * @returns {String} name of the agent to LB/FO to
     */
    _findLoadBalancerForAgent: function (agentGr, allClusters) {
        var self = this;

        if (!agentGr)
            return;

        var agentSysId = agentGr.getValue('sys_id');
        var agentFallbackName = agentGr.getValue('name');


        /**
         * Helper function to make fields in an array unique.
         * 
         * @param {*} value
         * @param {*} index
         * @param {*} arr
         * @returns {BinaryExpression}
         */
        var onlyUnique = function (value, index, arr) {
            return arr.indexOf(value) === index;
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

            self.log.debug("_getAgentCapabilities : ecc_agent_capability_m2m.do " + gr.getEncodedQuery());

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
         * 
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
         * @param {String} ofAgentSysId
         * @param {Array} failoverAgents
         * @returns {Array} list holding the sys_id of the capable agents
         */
        var _filterOnCapabilities = function (ofAgentSysId, failoverAgents) {

            var agentCaps = _getAgentCapabilities(ofAgentSysId)[ofAgentSysId];

            var newClusterAgents = [];
            if (!agentCaps)
                return newClusterAgents;

            var foCapabilities = _getAgentCapabilities(failoverAgents);
            if (!foCapabilities)
                return newClusterAgents;


            Object.keys(foCapabilities).forEach(function (foAgentSysId) {
                var candidateCaps = foCapabilities[foAgentSysId];
                self.log.debug("_filterOnCapabilities : Agent caps " + JSON.stringify(agentCaps) + " - candidateCaps :" + JSON.stringify(candidateCaps));

                // if the candidate can do 'ALL' it is always capable to take over
                // OR the candidate capabilities are more or equal the current
                if (candidateCaps.indexOf('ALL') !== -1 || _isSubset(agentCaps, candidateCaps)) {
                    newClusterAgents.push(foAgentSysId);
                }
            });

            return newClusterAgents;
        };



        /**
         * Randomly picks one agent from the passed list of agents
         * 
         * @param {Array} sameCapFoAgents
         * @returns {String} random agent name
         */
        var getRandomMidServer = function (sameCapFoAgents) {
            self.log.debug("getRandomMidServer : up and running agents with same capabilities " + JSON.stringify(sameCapFoAgents));

            var lbAgentsNum = sameCapFoAgents.length;
            if (lbAgentsNum) {
                var lbRandomPos = Math.floor(Math.random() * lbAgentsNum);
                var lbRandomSysId = sameCapFoAgents[lbRandomPos];

                var agentCache = new SNC.ECCAgentCache();
                var gr = agentCache.getBySysId(lbRandomSysId);

                if (gr) {
                    return gr.getValue('name');
                }
            }
            return null;
        };

        /**
         * Finds one failover agent with the same capabilities
         * 
         * @param {Object} agent
         * @returns {String} agent name
         */
        var getSameCapAgentFromFailover = function (agent) {
            var upFailoverAgents = [];
            agent.failover.forEach(function (foSysId) {
                // find all the down load balancers nodes and replace it with one failover node
                var fo = allClusters.failover[foSysId];
                if (!fo)
                    return;

                upFailoverAgents = upFailoverAgents.concat(fo.agentsUp);
            });

            var sameCapFoAgents = _filterOnCapabilities(agentSysId, upFailoverAgents);
            return getRandomMidServer(sameCapFoAgents);
        };

        /**
         * Finds one load balanced agent with the same capabilities
         * 
         * @param {Object} agent
         * @returns {String} agent name
         */
        var getSameCapAgentFromLoadBalance = function (agent) {
            // list of agents to share the load
            var upLoadBalanceAgents = [];
            var downLoadBalanceAgents = [];
            var upFailoverAgents = [];

            // these are all load balancers to the current mid server
            agent.loadBalance.forEach(function (lbSysId) {
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

            self.log.debug("getSameCapAgentFromLoadBalance : current agent load balancers " + JSON.stringify(agent.loadBalance));
            self.log.debug("getSameCapAgentFromLoadBalance : current agent running load balancer partners " + JSON.stringify(upLoadBalanceAgents));
            self.log.debug("getSameCapAgentFromLoadBalance : current agent stopped load balancer partners " + JSON.stringify(downLoadBalanceAgents));

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

            self.log.debug("getSameCapAgentFromLoadBalance : up running failover agents " + JSON.stringify(upFailoverAgents) + " to take over from stopped " + JSON.stringify(downLoadBalanceAgents));
            self.log.debug("getSameCapAgentFromLoadBalance : num down agents " + downLoadBalanceAgents.length);
            self.log.debug("getSameCapAgentFromLoadBalance : num failover agents " + upFailoverAgents.length);

            // if there are less or equal number of failover agents in place, take them all
            if (upFailoverAgents.length <= downLoadBalanceAgents.length) {
                // we need all of them
                upLoadBalanceAgents = upLoadBalanceAgents.concat(upFailoverAgents);
            } else {
                // there are more failover agents available then we need to have, random pick some
                downLoadBalanceAgents.forEach(function () {
                    var randomPos = Math.floor(Math.random() * upFailoverAgents.length);
                    // select a random failover from the remaining list
                    // splice makes the 'currentDownAgentsUpFailoverAgents' shorter by 1 every time it runs
                    upLoadBalanceAgents.push(upFailoverAgents.splice(randomPos, 1)[0]);
                });
            }

            self.log.debug("getSameCapAgentFromLoadBalance : up and running agents " + JSON.stringify(upLoadBalanceAgents));

            var sameCapFoAgents = _filterOnCapabilities(agentSysId, upLoadBalanceAgents);
            return getRandomMidServer(sameCapFoAgents);

        };

        // get the current agent object from that cluster
        var currAgent = allClusters.agents[agentSysId];

        // check if the agent has at least one failover or loadBalance agent
        if (!currAgent || (currAgent.failover.length == 0 && currAgent.loadBalance.length == 0)) {
            // mid server has no failover or load balance configuration
            self.log.debug("no lb/fo agents found for agent (sys_id) " + agentSysId);
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

    },

    type: 'MIDServerCluster'
};
