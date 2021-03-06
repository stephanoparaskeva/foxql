import foxqlIndex from "@foxql/foxql-index"
import peer from "@foxql/foxql-peer"
import storage from "./core/storage.js";
import events from './events.js';
import tokenization from './core/tokenization.js';

import nativeCollections from './collections.js';


class foxql {
    constructor(){
    
        this.storageOptions = {
            name : 'foxql-storage',
            interval : 100,
            saveInterval : false 
        }

        this.currentCollections = [];
        
        this.documentLengthInterval = {
            active : false,
            ms : 500,
            maxDocumentLength : 100
        };
    
        this.useAvaliableObjects = [
            'serverOptions',
            'storageOptions',
            'documentLengthInterval'
        ]
    
        this.databaseSaveProcessing = false

        this.database = new foxqlIndex(); 
        this.peer = new peer();
    }

    use(name, values)
    {
        if(this.useAvaliableObjects.includes(name)){
            this[name] = {...this[name], ...values}
        }
    }

    openNativeCollections()
    {
        nativeCollections.forEach(collection => {
            this.database.pushCollection(collection);
            const collectionName = collection.collectionName;
            this.currentCollections.push(collectionName);

            this.database.useCollection(collectionName).registerAnalyzer('tokenizer', tokenization);
        })
    }

    open()
    {
        const saveInterval = this.storageOptions.saveInterval || false;

        if(saveInterval) {
            this.storage = new storage(
                this.storageOptions
            );

            this.loadDumpOnStorage();
        }

        if(saveInterval) {
            this.indexDatabaseLoop();
        }
        
        if(this.documentLengthInterval.active) {
            this.deleteDatabaseLoop();
        }

        this.peer.open();

    }

    deleteDatabaseLoop()
    {
        const options = this.documentLengthInterval;

        setInterval(()=>{
            options.maxDocumentsInCollections.forEach(collectionOptions => {
                const targetCollection = collectionOptions.collection;
                const targetLength = collectionOptions.maxDocument;
                
                const collection = this.database.useCollection(targetCollection);
                if(collection.documentLength > targetLength) {
                    const lastDocumentRef = Object.keys(collection.documents).pop();
                    collection.deleteDoc(lastDocumentRef);
                }
            });
        }, options.interval);
    }

    loadDumpOnStorage()
    {
        const dump = this.storage.get();
        if(dump && typeof dump === 'string') {
            try {
                this.database.import(
                    JSON.parse(dump)
                );

                nativeCollections.forEach(collection => {
                    const collectionName = collection.collectionName;
                    this.database.useCollection(collectionName).registerAnalyzer('tokenizer', tokenization);
                })
            }catch(e)
            {
                throw Error(e);
            }
        }
    }

    indexDatabaseLoop()
    {
        setInterval(()=>{

            this.currentCollections.forEach(collection => {
                const targetCollection = this.database.collections[collection];
                if(targetCollection.waitingSave && !this.databaseSaveProcessing){
                    this.databaseSaveProcessing = true;
    
                    const dump = this.database.export();
                    this.storage.set(JSON.stringify(dump));
    
                    this.databaseSaveProcessing = false;
                    targetCollection.waitingSave = false;
                }  
            })
        }, this.storageOptions.interval);
    }


    pushEvents(list)
    {
        list.forEach( name => {
            const eventListener = events[name] || false;
            if(eventListener){
                this.peer.onPeer(eventListener.name, eventListener.listener.bind(this));
            }
        });     
    }


    async publishDocument(document, collection)
    {
        if(typeof collection !== 'string') return false;
        if(!this.currentCollections.includes(collection)) return false;

        await this.peer.broadcast({
            listener : 'onDocument',
            data : {
                document : document,
                collection : collection
            }
        });
    }   

    randomString()
    {
        return Math.random().toString(36).substring(0,30).replace(/\./gi, '');
    }

    async search({query, timeOut, collections})
    {
        let tempResult = [];
        let documentMap = {}
        let resultCount = 0;

        if(collections == undefined) {
            collections = this.currentCollections;
        }

        const generatedListenerName = this.randomString()

        const body = {
            listener : generatedListenerName,
            query : query,
            collections : collections
        };

        await this.peer.broadcast({
            listener : 'onSearch',
            data : body
        })

        this.peer.onPeer(generatedListenerName,async (data)=> {
            const peerResuls = data.results;
            for(let collection in peerResuls) {

                const documents = peerResuls[collection];
                resultCount+= documents.length;

                documents.forEach( document => {
                    if(documentMap[document.document.documentId] == undefined){
                        document._collection = collection;
                        tempResult.push(document);
                        documentMap[document.document.documentId] = 1;
                    }
                })
                
            }
        })

        return new Promise((resolve, reject)=>{
            setTimeout(() => {

                tempResult.sort((a,b)=>{
                    return b.document.score - a.document.score;
                });

                delete this.peer.peerEvents[generatedListenerName]
                resolve({
                    results : tempResult,
                    count : resultCount
                })
            }, (timeOut + 500) );
        });
    }

    async randomDocument({limit, collection, timeOut}, callback)
    {
        const generatedListenerName = this.randomString()

        await this.peer.broadcast({
            listener : 'onRandom',
            data : {
                limit : limit,
                collection : collection,
                listener : generatedListenerName
            }
        });

        let results = [];

        this.peer.onPeer(generatedListenerName, async (body)=> {
            results = results.concat(body.results);
        });

        setTimeout(()=> {
            callback(results);
            delete this.peer.peerEvents[generatedListenerName]
        }, timeOut);
        

    }

    async findDocument({collection, ref, timeOut, match})
    {
        const generatedListenerName = this.randomString()

        let documentPool = [];

        this.peer.onPeer(generatedListenerName, async (body)=> {
            let results = body.results;
            if(results.length > 0){
                documentPool = documentPool.concat(results)
            }
        });

        await this.peer.broadcast({
            listener : 'onDocumentByRef',
            data : {
                listener : generatedListenerName,
                ref : ref,
                collection : collection,
                match : match || false
            }
        });

        return new Promise((resolve)=>{
            
            setTimeout(()=> {
                resolve(documentPool);
                delete this.peer.peerEvents[generatedListenerName]
            }, timeOut);

        });
    }

    dropPeer(id)
    {
        if(this.peer.connections[id] !== undefined) {
            this.peer.connections[id].dataChannel.close();

            delete this.peer.connections[id]
        }
    }

}




export default foxql